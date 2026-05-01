import { z } from "zod";

// Single source of truth for the LLM output contract. The same schema is used
// to (a) validate provider responses and (b) describe the contract to OpenAI's
// structured-output API.
export const AnalysisSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  feature_requests: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20),
  actionable_insight: z.string().min(1).max(1000),
});

export type AnalysisResult = z.infer<typeof AnalysisSchema>;

// What providers return. We always surface the raw string so the worker can
// persist it for auditability, regardless of whether parsing/validation passes.
export interface LlmRawResponse {
  raw: string;
}

// Errors that should cause the worker to attempt one transport-level retry.
// Anything else (invalid JSON, schema mismatch) is a permanent FAILED.
export class LlmTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmTransportError";
  }
}

export interface LlmProvider {
  readonly name: string;
  analyze(content: string, opts: { signal: AbortSignal }): Promise<LlmRawResponse>;
}
