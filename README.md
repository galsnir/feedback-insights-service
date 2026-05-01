# Feedback Insights Service

[![CI](https://github.com/galsnir/feedback-insights-service/actions/workflows/ci.yml/badge.svg)](https://github.com/galsnir/feedback-insights-service/actions/workflows/ci.yml)

A small Node.js + TypeScript backend that accepts free-text user feedback and asynchronously extracts structured insights (sentiment, feature requests, actionable insight) using an LLM. Built for the AI-Assisted Engineering Challenge (3-hour timebox).

The service is deliberately small. Engineering judgment, defensive AI handling, and clear state management were prioritized over breadth.

---

## Quick start

Requires Node.js 20+.

```bash
npm install
cp .env.example .env             # defaults to LLM_PROVIDER=mock (no key needed)
npx prisma db push --skip-generate
npm run dev                      # http://localhost:3000
```

Run tests:

```bash
npm test
```

To use the real OpenAI provider:

```bash
# in .env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

---

## API

| Method | Path                    | Description                                                                  |
| ------ | ----------------------- | ---------------------------------------------------------------------------- |
| POST   | `/feedback`             | Submit `{ "content": "..." }`. Returns 201 with `{ id, status: "RECEIVED" }`. |
| GET    | `/feedback`             | List feedback. Query: `status`, `limit` (1..100), `cursor` (id-based).        |
| GET    | `/feedback/:id`         | Single feedback with analysis (when DONE).                                    |
| POST   | `/feedback/:id/retry`   | Re-enqueue a FAILED feedback. 409 if not currently FAILED.                    |
| GET    | `/health`               | Liveness + queue depth.                                                       |

JSON field names use snake_case (matching the spec and the LLM output schema).

Example:

```bash
curl -X POST localhost:3000/feedback -H 'content-type: application/json' \
  -d '{"content":"The app should support dark mode and is a bit slow."}'
# -> {"id":"cmom...","status":"RECEIVED"}

curl localhost:3000/feedback/cmom...
```

Returns:

```json
{
  "id": "cmom...",
  "content": "The app should support dark mode and is a bit slow.",
  "status": "DONE",
  "attempts": 1,
  "last_error": null,
  "raw_response": "{\"sentiment\":\"negative\", ...}",
  "created_at": "2026-05-01T12:00:00.000Z",
  "updated_at": "2026-05-01T12:00:01.000Z",
  "analysis": {
    "id": "cmom...",
    "sentiment": "negative",
    "actionable_insight": "...",
    "feature_requests": [{ "title": "dark mode", "confidence": 0.6 }],
    "raw_response": "{\"sentiment\":\"negative\", ...}",
    "created_at": "2026-05-01T12:00:01.000Z"
  }
}
```

---

## Architecture

```
HTTP → FeedbackService → Prisma (SQLite)
                       ↘ InMemoryQueue → AnalysisWorker → LlmProvider
                                                        → Validate (Zod)
                                                        → Persist (raw + structured)
```

### State machine

```
RECEIVED ──worker claims──▶ ANALYZING ──valid──▶ DONE
                                       └─error─▶ FAILED ──/retry──▶ RECEIVED
```

Transitions are guarded by `prisma.feedback.updateMany({ where: { id, status: expected } })` so a job cannot move from a state it is not currently in. This is the SQLite-friendly equivalent of a CAS (compare-and-swap) and prevents double-processing if the same job is somehow enqueued twice.

### Key files

- `src/llm/types.ts` — `AnalysisSchema` (Zod) — single source of truth for the LLM contract, used both for validation and as the OpenAI structured-output schema.
- `src/llm/mockProvider.ts` — deterministic provider used by default and in tests. Recognises magic tokens (`__FAIL_INVALID_JSON__`, `__FAIL_SCHEMA__`, `__FAIL_TRANSPORT__`, `__FAIL_TIMEOUT__`) so failure paths are easy to demo.
- `src/llm/openAiProvider.ts` — real OpenAI integration using `response_format: json_schema` with `strict: true`.
- `src/queue/inMemoryQueue.ts` — bounded-concurrency FIFO with `idle()` and `shutdown()`.
- `src/workers/analysisWorker.ts` — the heart of the system. Claims jobs via guarded transition, dedupes by content hash, calls the provider with timeout + one transport-level retry, validates with Zod, handles unique-constraint races on the `Analysis` row.
- `src/services/feedbackService.ts` — create / list / get / retry orchestration.
- `prisma/schema.prisma` — `Feedback` (one per submission), `Analysis` (one per unique content hash, **unique index**), `FeatureRequest`.

---

## Design decisions and tradeoffs

### Pluggable LLM provider, mock by default

Reviewers can run the project with zero credentials. More importantly, the mock provider can deterministically produce broken outputs (invalid JSON, schema violations, transport errors, timeouts), which lets the test suite actually exercise the FAILED state and the retry endpoint — paths that are hard to provoke against a real model. The OpenAI adapter is a sibling implementation behind the same `LlmProvider` interface and is selected by `LLM_PROVIDER=openai`.

### Guardrail: SHA-256 content-hash deduplication (chose 1 of 4)

Implemented in the worker, not at the submission layer:

- Every submission is still persisted as its own `Feedback` row (you don't lose audit history of who submitted what when).
- Before calling the LLM, the worker looks up `Analysis` by `contentHash`. On a hit, the new `Feedback` is linked to the existing `Analysis` and immediately marked `DONE`. Zero LLM calls.
- The `Analysis.contentHash` column has a `UNIQUE` constraint. If two identical submissions race through the worker concurrently, the loser catches Prisma error `P2002` and falls back to reading the winner's row. Both end up linked to the same analysis.

Why this guardrail over the others:

- Forces a real schema decision (separate `Analysis` table referenced by N `Feedback` rows) rather than just middleware.
- Exposes a real concurrency case (the unique-constraint race), which we handle explicitly.
- Composes naturally with the "persist raw + structured result" requirement.
- Cache would be redundant given SQLite already gives durable persistence; rate-limit is orthogonal to AI correctness; truncation is too narrow.

Normalization is intentionally minimal: `content.trim()` only. Casing and internal whitespace are significant — "Bug" and "bug" remain distinct.

### Defensive AI handling

The validation pipeline treats every output as untrusted:

1. `JSON.parse` — fail → `FAILED` with `last_error = "invalid_json: ..."`.
2. `AnalysisSchema.safeParse` — fail → `FAILED` with `last_error = "schema_invalid: <field>: <issue>"`. The schema enforces `sentiment ∈ {positive, neutral, negative}`, `confidence ∈ [0, 1]`, non-empty `actionable_insight`, etc.
3. **Raw response is always persisted on `Feedback.raw_response` immediately after the LLM call returns**, before any parsing. Failures keep the full raw output (no truncation) so you can audit exactly what the model said. On success, the same raw is also copied to `Analysis.raw_response`. Dedupe-cache hits and transport-level failures legitimately have no raw to persist; for those `raw_response` is `null`.

Transport errors (HTTP 5xx, abort, timeout) get **one in-worker retry** with a 50ms delay. Validation errors are **not** retried — re-asking the same model the same question typically produces the same broken output, and it would just burn tokens.

### Retry is an explicit endpoint, not auto-backoff

`POST /feedback/:id/retry` is the only way to move from `FAILED` back to `RECEIVED`. It is rejected with 409 if the current state is anything other than `FAILED`. Reasoning:

- Silent auto-retry would hide systemic problems (bad prompt, model deprecation).
- The state machine stays observable: every transition is intentional and visible in the DB.
- A human (or an external scheduler) decides what's worth retrying.

### In-process queue + automatic crash recovery

A custom `InMemoryQueue` with bounded concurrency. Acceptable for a 3-hour scope; documented as a swap-point for BullMQ / SQS / a Postgres advisory-lock-based queue in production. Jobs in flight at process exit would otherwise be LOST (status frozen at `ANALYZING`).

To recover from this, a **sweeper** (`src/workers/sweeper.ts`) runs every `SWEEPER_INTERVAL_MS` (default 30s) and atomically flips any row stuck in `ANALYZING` for more than `SWEEPER_STALE_AFTER_MS` (default 2min) back to `RECEIVED`, then re-enqueues it. The reset is a guarded `updateMany({ where: { status: 'ANALYZING', updatedAt: { lt: cutoff } } })` so a live worker mid-job (which bumps `updatedAt` on every transition) cannot be hijacked. Set `SWEEPER_STALE_AFTER_MS` comfortably above `LLM_TIMEOUT_MS` to avoid double-processing genuinely slow runs — and even if a race does occur, the worker's `RECEIVED -> ANALYZING` claim step makes the loser a no-op.

The `POST /feedback/:id/retry` endpoint remains for **`FAILED`** items (where automatic recovery is not appropriate — a permanent validation error needs a human to decide whether retrying is worth it).

### What I deliberately did NOT do (per the spec's "we do not care about" list)

- No UI.
- No auth, rate limiting, or per-IP throttling.
- No deployment artifacts (Dockerfile, CI).
- No exhaustive test coverage — 4 integration tests covering the most important paths (happy, dedupe, invalid output → FAILED → retry, transport flake).
- No Prisma migrations history — `db push` is fine for a single-developer prototype.

---

## What I'd add with more time

- Persistent queue (BullMQ on Redis or a `jobs` table with `SELECT ... FOR UPDATE SKIP LOCKED` on Postgres) so jobs survive restarts. (The sweeper handles single-process crash recovery, but a persistent queue would also handle in-flight jobs if the process is killed mid-LLM-call rather than mid-DB-transaction.)
- Exponential backoff with jitter on transport retries; a dead-letter table for jobs that fail N times in a row.
- Per-IP rate limit on `POST /feedback` (real spam protection rather than a content guardrail).
- Structured logging + OpenTelemetry traces around the worker.
- Cost/latency metrics per provider, exposed on `/metrics`.
- Stronger prompt + a small evaluation set so we can detect model regressions when changing models.

---

## AI Collaboration Log

See [`AI_COLLAB_LOG.md`](./AI_COLLAB_LOG.md).
