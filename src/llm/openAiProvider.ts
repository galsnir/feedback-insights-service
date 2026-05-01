import OpenAI from "openai";
import { type LlmProvider, type LlmRawResponse, LlmTransportError } from "./types";

const SYSTEM_PROMPT = [
  "You analyze a single piece of user product feedback and emit a JSON object",
  "matching the provided schema EXACTLY. No prose, no markdown, no extra fields.",
  "",
  "Rules:",
  "- sentiment: one of 'positive' | 'neutral' | 'negative' based on overall tone.",
  "- feature_requests: items the user is asking for. Each has a short 'title'",
  "  (max 200 chars) and a 'confidence' float in [0,1] expressing how sure you",
  "  are it is a real request (not a complaint).",
  "  If there are none, return an empty array.",
  "- actionable_insight: one sentence describing what the team should do.",
].join("\n");

const RESPONSE_JSON_SCHEMA = {
  name: "feedback_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sentiment", "feature_requests", "actionable_insight"],
    properties: {
      sentiment: {
        type: "string",
        enum: ["positive", "neutral", "negative"],
      },
      feature_requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "confidence"],
          properties: {
            title: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
      actionable_insight: { type: "string" },
    },
  },
} as const;

export class OpenAiLlmProvider implements LlmProvider {
  public readonly name = "openai";

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? "gpt-4o-mini";
  }

  public async analyze(
    content: string,
    opts: { signal: AbortSignal },
  ): Promise<LlmRawResponse> {
    try {
      const resp = await this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0,
          response_format: { type: "json_schema", json_schema: RESPONSE_JSON_SCHEMA },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content },
          ],
        },
        { signal: opts.signal },
      );

      const raw = resp.choices[0]?.message?.content ?? "";
      if (!raw) {
        // Treat empty content as a transport-level anomaly -- worth one retry.
        throw new LlmTransportError("openai: empty response");
      }
      return { raw };
    } catch (err) {
      if (err instanceof LlmTransportError) throw err;
      // OpenAI SDK throws APIError on transport/HTTP issues. We treat any
      // non-validation error here as transport-level; schema/parse errors are
      // detected later in the worker.
      throw new LlmTransportError(`openai: ${(err as Error).message}`, { cause: err });
    }
  }
}
