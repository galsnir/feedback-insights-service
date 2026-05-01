# AI Collaboration Log

## Tools used

- **Cursor** with **Claude (Sonnet/Opus class)** as the primary coding assistant for scaffolding, schema design, the worker state machine, and tests.
- The challenge spec PDF was attached directly to the conversation, and the assistant was asked to design the project before writing any code (Plan mode). The plan file lives at `.cursor/plans/feedback-insights-service_*.plan.md`.

## How the collaboration was structured

1. **Read the spec, then choose constraints up front.** Before writing code, I had the assistant ask me to lock the stack (Node + Express + Prisma + SQLite), the LLM strategy (pluggable interface with mock default), and the guardrail (content-hash dedupe). Locking these three decisions made the rest of the work essentially mechanical — no mid-implementation rewrites.
2. **One source of truth for the LLM contract.** I told the assistant to define the output schema in Zod (`AnalysisSchema` in `src/llm/types.ts`) and reuse it as both the runtime validator and the input to OpenAI's `response_format: json_schema`. Without that constraint, the assistant would have happily duplicated the schema in two slightly-different places.
3. **Steered toward defensive defaults.** Several places where I had to push back against optimistic defaults — see "Things the AI got wrong" below.

## Representative prompts (paraphrased)

1. **Plan-first prompt:**
   > "Read the attached challenge PDF. Don't write code yet. Ask me whatever clarifying questions are needed about stack and key tradeoffs, then produce a plan I can approve."

2. **Worker design prompt:**
   > "Design `analysisWorker` so that the state transition `RECEIVED -> ANALYZING` is a guarded compare-and-swap (use `prisma.feedback.updateMany({ where: { id, status: 'RECEIVED' } })` and check `count`). Always persist the raw LLM response on failure. Validation errors must NOT trigger retries — only transport errors should, and at most once."

3. **Test design prompt:**
   > "Write a Vitest integration test that covers: happy path; two identical submissions sharing one Analysis row; an invalid LLM output going FAILED, being retried via the endpoint, and reaching DONE. Use a stateful 'scripted' provider for the retry case so first-call returns invalid JSON and second-call returns valid output."

## Concrete example: the AI was wrong, I corrected it

**What happened.** When I asked for the worker, the first draft handled validation failures by *retrying the LLM call* up to N times before marking `FAILED`. It also silently swallowed the raw response on failure — only the parsed/validated object was persisted.

**Why that was wrong.**

- Re-asking the same model the same question almost always produces the same broken output. So "retry on validation failure" just burns tokens and delays the inevitable `FAILED`.
- Throwing away the raw response on failure removes the only artifact you could use to debug *why* the model misbehaved. The challenge spec explicitly says "Persist: the raw AI response."
- It also blurred the distinction between transient transport errors (worth retrying) and permanent contract violations (not worth retrying).

**The correction.** I had the assistant rewrite `analysisWorker.ts` so:

- A typed `LlmTransportError` is the **only** thing that triggers an in-worker retry, and at most once. Anything else (parse error, schema mismatch) is a permanent `FAILED`.
- The raw response is persisted unconditionally on failure (truncated to 2 KB onto `Feedback.lastError` as `"<reason> | raw=<...>"`), and on success onto `Analysis.rawResponse`.
- Re-attempting a `FAILED` job is moved out of the worker entirely and into the explicit `POST /feedback/:id/retry` endpoint, so retries are always intentional and observable.

**A second correction.** The first cut of the OpenAI provider used `response_format: { type: "json_object" }`. JSON-object mode guarantees parseable JSON but does **not** enforce the schema, so the model can still invent extra fields or wrong types. I switched it to `response_format: { type: "json_schema", strict: true }` and pinned the same shape Zod enforces. Even with strict mode I left the Zod check in place as a belt-and-braces guard — provider behavior is not a contract I want to assume.

**A third correction (smaller).** The assistant initially wanted to dedupe at the API layer (return the existing analysis directly from `POST /feedback` if the hash matched). I moved dedupe down into the worker so every submission still gets a `Feedback` row (preserving audit history of who/when), and only the *analysis* is shared.

## What I would improve with more time

- A persistent queue (BullMQ or Postgres `SKIP LOCKED`) so jobs survive process restarts. The current in-memory queue + sweeper handles the common case (crashed worker, row stuck in `ANALYZING`) but a persistent queue would survive a kill mid-LLM-call rather than mid-DB-transaction.
- A small **eval harness**: a fixtures file of (input, expected sentiment / expected feature-request keywords) pairs that runs against whatever provider is configured, so swapping models or editing the prompt produces a measurable diff rather than a vibe.
- Exponential backoff with jitter for transport retries, and a dead-letter table for jobs that fail N times.
- Cost/latency metrics per provider on a `/metrics` endpoint.
- A real per-IP rate limit on `POST /feedback` (separate from the AI guardrail — that's spam protection, not contract enforcement).
