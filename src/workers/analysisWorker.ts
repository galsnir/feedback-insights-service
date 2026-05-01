import { Prisma, type PrismaClient } from "@prisma/client";
import { AnalysisSchema, LlmTransportError, type LlmProvider } from "../llm/types";
import { FeedbackStatus } from "../lib/status";

export interface AnalysisJob {
  feedbackId: string;
}

export interface AnalysisWorkerOptions {
  prisma: PrismaClient;
  provider: LlmProvider;
  timeoutMs?: number;
  // Number of in-worker retries on transport-level errors. The default of 1
  // means up to two attempts total per job invocation. Permanent failures
  // (invalid JSON / schema mismatch) are NOT retried here.
  transportRetries?: number;
}

export function createAnalysisHandler(opts: AnalysisWorkerOptions) {
  const { prisma, provider } = opts;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const transportRetries = opts.transportRetries ?? 1;

  return async function handle(job: AnalysisJob): Promise<void> {
    const claimed = await prisma.feedback.updateMany({
      where: {
        id: job.feedbackId,
        status: { in: [FeedbackStatus.RECEIVED] },
      },
      data: {
        status: FeedbackStatus.ANALYZING,
        attempts: { increment: 1 },
        lastError: null,
        // Clear any raw response left over from a prior failed attempt, so
        // the new attempt's raw fully replaces it (or stays null if dedupe
        // skips the LLM call this time).
        rawResponse: null,
      },
    });

    if (claimed.count === 0) {
      // Already moved by another worker, or no longer eligible (DONE/FAILED).
      return;
    }

    const feedback = await prisma.feedback.findUnique({
      where: { id: job.feedbackId },
      select: { id: true, content: true, contentHash: true },
    });
    if (!feedback) return;

    // Dedupe guardrail: if we already have an Analysis for this content hash,
    // link to it without spending another LLM call.
    const existing = await prisma.analysis.findUnique({
      where: { contentHash: feedback.contentHash },
      select: { id: true },
    });
    if (existing) {
      await markDone(prisma, feedback.id, existing.id);
      return;
    }

    let raw: string;
    try {
      raw = await callProviderWithRetry(provider, feedback.content, {
        timeoutMs,
        retries: transportRetries,
      });
    } catch (err) {
      // Transport failures have no raw body to persist.
      await markFailed(prisma, feedback.id, `transport: ${(err as Error).message}`);
      return;
    }

    // Persist raw IMMEDIATELY, before any parsing. This guarantees that every
    // LLM call's output is auditable, regardless of what happens next.
    await prisma.feedback.update({
      where: { id: feedback.id },
      data: { rawResponse: raw },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await markFailed(prisma, feedback.id, `invalid_json: ${(err as Error).message}`);
      return;
    }

    const validation = AnalysisSchema.safeParse(parsed);
    if (!validation.success) {
      await markFailed(
        prisma,
        feedback.id,
        `schema_invalid: ${validation.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
      );
      return;
    }

    const result = validation.data;

    // Create the Analysis row + feature requests, then link the Feedback.
    // We catch the unique-constraint race (two identical submissions analysed
    // concurrently) and fall back to the existing row.
    let analysisId: string;
    try {
      const created = await prisma.analysis.create({
        data: {
          contentHash: feedback.contentHash,
          rawResponse: raw,
          sentiment: result.sentiment,
          actionableInsight: result.actionable_insight,
          featureRequests: {
            create: result.feature_requests.map((fr) => ({
              title: fr.title,
              confidence: fr.confidence,
            })),
          },
        },
        select: { id: true },
      });
      analysisId = created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const winner = await prisma.analysis.findUnique({
          where: { contentHash: feedback.contentHash },
          select: { id: true },
        });
        if (!winner) throw err;
        analysisId = winner.id;
      } else {
        throw err;
      }
    }

    await markDone(prisma, feedback.id, analysisId);
  };
}

async function callProviderWithRetry(
  provider: LlmProvider,
  content: string,
  opts: { timeoutMs: number; retries: number },
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const { raw } = await provider.analyze(content, { signal: ac.signal });
      return raw;
    } catch (err) {
      lastErr = err;
      const isTransport = err instanceof LlmTransportError || ac.signal.aborted;
      if (!isTransport || attempt === opts.retries) {
        throw err;
      }
      // small fixed backoff is fine for a 3h project
      await delay(50);
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastErr ?? new Error("provider failed");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markDone(
  prisma: PrismaClient,
  feedbackId: string,
  analysisId: string,
): Promise<void> {
  await prisma.feedback.updateMany({
    where: { id: feedbackId, status: FeedbackStatus.ANALYZING },
    data: {
      status: FeedbackStatus.DONE,
      analysisId,
      lastError: null,
    },
  });
}

async function markFailed(
  prisma: PrismaClient,
  feedbackId: string,
  reason: string,
): Promise<void> {
  // The raw response (when there is one) is already on Feedback.rawResponse
  // by this point. lastError is purely the human-readable reason. The
  // structured Analysis is intentionally NOT created for failed validations --
  // the spec says "persist raw + validated result"; a failed validation has
  // no validated result to persist.
  await prisma.feedback.updateMany({
    where: { id: feedbackId, status: FeedbackStatus.ANALYZING },
    data: {
      status: FeedbackStatus.FAILED,
      lastError: reason,
    },
  });
}
