import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import request from "supertest";

// IMPORTANT: set DATABASE_URL BEFORE importing anything that touches Prisma.
const TEST_DB_PATH = path.join(__dirname, "test.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.LLM_PROVIDER = "mock";

import { PrismaClient } from "@prisma/client";
import { InMemoryQueue } from "../src/queue/inMemoryQueue";
import { createAnalysisHandler, type AnalysisJob } from "../src/workers/analysisWorker";
import { buildApp } from "../src/server";
import {
  type LlmProvider,
  type LlmRawResponse,
  LlmTransportError,
} from "../src/llm/types";
import { MockLlmProvider } from "../src/llm/mockProvider";
import { startSweeper } from "../src/workers/sweeper";
import { FeedbackStatus } from "../src/lib/status";
import { hashContent } from "../src/lib/hash";

// A test provider whose behavior can be flipped at runtime. Used for the
// retry test: first call returns invalid JSON, second returns valid output.
class ScriptedProvider implements LlmProvider {
  public readonly name = "scripted";
  public calls = 0;
  constructor(private readonly script: ((call: number) => LlmRawResponse | Error)[]) {}
  public async analyze(_content: string): Promise<LlmRawResponse> {
    const idx = Math.min(this.calls, this.script.length - 1);
    this.calls += 1;
    const out = this.script[idx](this.calls);
    if (out instanceof Error) throw out;
    return out;
  }
}

let prisma: PrismaClient;

beforeAll(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}` },
    stdio: "ignore",
  });
  prisma = new PrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

beforeEach(async () => {
  await prisma.featureRequest.deleteMany();
  await prisma.feedback.deleteMany();
  await prisma.analysis.deleteMany();
});

function buildHarness(provider: LlmProvider) {
  const queue = new InMemoryQueue<AnalysisJob>({ concurrency: 1 });
  const handler = createAnalysisHandler({ prisma, provider, timeoutMs: 1000 });
  queue.registerHandler(handler);
  const app = buildApp({ prisma, queue });
  return { app, queue };
}

describe("Feedback API", () => {
  it("happy path: submits, processes, and returns structured analysis", async () => {
    const { app, queue } = buildHarness(new MockLlmProvider());

    const submitRes = await request(app)
      .post("/feedback")
      .send({ content: "The app is great and fast! I would like dark mode." })
      .expect(201);

    expect(submitRes.body).toMatchObject({ status: "RECEIVED" });
    const id = submitRes.body.id as string;

    await queue.idle();

    const getRes = await request(app).get(`/feedback/${id}`).expect(200);
    expect(getRes.body.status).toBe("DONE");
    expect(getRes.body.analysis).toBeTruthy();
    expect(getRes.body.analysis.sentiment).toBe("positive");
    expect(getRes.body.analysis.feature_requests.length).toBeGreaterThan(0);
    expect(getRes.body.analysis.feature_requests[0].title.toLowerCase()).toContain(
      "dark mode",
    );
    expect(typeof getRes.body.analysis.actionable_insight).toBe("string");
    // Spec field names + raw response on both views
    expect(typeof getRes.body.created_at).toBe("string");
    expect(typeof getRes.body.updated_at).toBe("string");
    expect(typeof getRes.body.raw_response).toBe("string");
    expect(typeof getRes.body.analysis.raw_response).toBe("string");
    // The raw response should be valid JSON parseable to the same shape.
    const parsedRaw = JSON.parse(getRes.body.raw_response);
    expect(parsedRaw.sentiment).toBe("positive");
  });

  it("dedupe: identical content shares a single Analysis row", async () => {
    const { app, queue } = buildHarness(new MockLlmProvider());
    const content = "The login page is broken and crashes on submit.";

    const a = await request(app).post("/feedback").send({ content }).expect(201);
    const b = await request(app).post("/feedback").send({ content }).expect(201);
    await queue.idle();

    const aRes = await request(app).get(`/feedback/${a.body.id}`).expect(200);
    const bRes = await request(app).get(`/feedback/${b.body.id}`).expect(200);
    expect(aRes.body.status).toBe("DONE");
    expect(bRes.body.status).toBe("DONE");
    expect(aRes.body.analysis.id).toBe(bRes.body.analysis.id);

    const analysisCount = await prisma.analysis.count();
    expect(analysisCount).toBe(1);
  });

  it("invalid LLM output -> FAILED -> manual retry succeeds", async () => {
    const provider = new ScriptedProvider([
      // First attempt: invalid JSON. Worker performs no transport-level retry
      // for parse errors, so this becomes FAILED immediately.
      () => ({ raw: "not json {{{" }),
      // After /retry: valid response.
      () => ({
        raw: JSON.stringify({
          sentiment: "neutral",
          feature_requests: [],
          actionable_insight: "Keep observing.",
        }),
      }),
    ]);
    const { app, queue } = buildHarness(provider);

    const submit = await request(app)
      .post("/feedback")
      .send({ content: "this content does not matter for the scripted provider" })
      .expect(201);
    const id = submit.body.id as string;
    await queue.idle();

    const failedRes = await request(app).get(`/feedback/${id}`).expect(200);
    expect(failedRes.body.status).toBe("FAILED");
    expect(failedRes.body.last_error).toMatch(/invalid_json/);
    // Raw response must be persisted EVEN on failure (spec requirement) and
    // it must be the actual full bad output, not truncated into last_error.
    expect(failedRes.body.raw_response).toBe("not json {{{");
    expect(failedRes.body.attempts).toBe(1);

    const okRes = await request(app)
      .post(`/feedback/${id}/retry`)
      .send()
      .expect(202);
    expect(okRes.body.status).toBe("RECEIVED");

    await queue.idle();

    const finalRes = await request(app).get(`/feedback/${id}`).expect(200);
    expect(finalRes.body.status).toBe("DONE");
    expect(finalRes.body.analysis.sentiment).toBe("neutral");
    expect(finalRes.body.attempts).toBe(2);
    expect(finalRes.body.last_error).toBeNull();
    // After a successful retry the raw on the Feedback row must be the NEW
    // raw, not the stale one from the prior failed attempt.
    expect(finalRes.body.raw_response).toContain('"sentiment":"neutral"');

    // A second retry should now be rejected because state is DONE.
    await request(app).post(`/feedback/${id}/retry`).send().expect(409);
  });

  it("schema-invalid output -> FAILED with raw response persisted", async () => {
    const badRaw = JSON.stringify({
      sentiment: "ecstatic", // not in enum
      feature_requests: [{ title: "x", confidence: "high" }], // confidence wrong type
      actionable_insight: "n/a",
    });
    const provider = new ScriptedProvider([() => ({ raw: badRaw })]);
    const { app, queue } = buildHarness(provider);

    const submit = await request(app)
      .post("/feedback")
      .send({ content: "schema invalid path" })
      .expect(201);
    await queue.idle();

    const res = await request(app).get(`/feedback/${submit.body.id}`).expect(200);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.last_error).toMatch(/schema_invalid/);
    expect(res.body.last_error).toMatch(/sentiment/);
    expect(res.body.raw_response).toBe(badRaw);
    expect(res.body.analysis).toBeNull();
  });

  it("sweeper rescues feedback stuck in ANALYZING and reruns it", async () => {
    const { app, queue } = buildHarness(new MockLlmProvider());

    // Simulate a process that crashed mid-job: an ANALYZING row whose
    // updatedAt is far in the past, with no in-flight worker for it.
    const stale = new Date(Date.now() - 10 * 60_000);
    const content = "the dashboard is amazing and very fast";
    const stuck = await prisma.feedback.create({
      data: {
        content,
        contentHash: hashContent(content),
        status: FeedbackStatus.ANALYZING,
        attempts: 1,
        updatedAt: stale,
      },
    });
    // Prisma ignores updatedAt on create() because of @updatedAt, so we force
    // it with raw SQL. NOTE: Prisma stores DateTime in SQLite as INTEGER
    // (ms since epoch), not ISO TEXT, so we must pass getTime().
    await prisma.$executeRawUnsafe(
      `UPDATE Feedback SET updatedAt = ? WHERE id = ?`,
      stale.getTime(),
      stuck.id,
    );

    const sweeper = startSweeper({
      prisma,
      queue,
      intervalMs: 60_000, // unused; we drive ticks manually
      staleAfterMs: 1_000,
    });

    const rescued = await sweeper.tickNow();
    expect(rescued).toContain(stuck.id);

    await queue.idle();
    await sweeper.stop();

    const finalRes = await request(app).get(`/feedback/${stuck.id}`).expect(200);
    expect(finalRes.body.status).toBe("DONE");
    expect(finalRes.body.analysis.sentiment).toBe("positive");
  });

  it("sweeper does NOT touch rows that are not stale", async () => {
    const { queue } = buildHarness(new MockLlmProvider());
    const fresh = await prisma.feedback.create({
      data: {
        content: "fresh row",
        contentHash: hashContent("fresh row"),
        status: FeedbackStatus.ANALYZING,
      },
    });

    const sweeper = startSweeper({
      prisma,
      queue,
      intervalMs: 60_000,
      staleAfterMs: 60_000,
    });
    const rescued = await sweeper.tickNow();
    await sweeper.stop();

    expect(rescued).not.toContain(fresh.id);
    const after = await prisma.feedback.findUnique({ where: { id: fresh.id } });
    expect(after?.status).toBe("ANALYZING");
  });

  it("transport failures are retried within a single job invocation", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: "flaky",
      async analyze() {
        calls += 1;
        if (calls === 1) throw new LlmTransportError("flaky: try again");
        return {
          raw: JSON.stringify({
            sentiment: "positive",
            feature_requests: [],
            actionable_insight: "ok",
          }),
        };
      },
    };
    const { app, queue } = buildHarness(provider);

    const submit = await request(app)
      .post("/feedback")
      .send({ content: "transient flake test" })
      .expect(201);
    await queue.idle();

    const res = await request(app).get(`/feedback/${submit.body.id}`).expect(200);
    expect(calls).toBe(2);
    expect(res.body.status).toBe("DONE");
    expect(res.body.attempts).toBe(1);
  });
});
