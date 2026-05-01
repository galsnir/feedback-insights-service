import type { LlmProvider } from "./types";
import { MockLlmProvider } from "./mockProvider";
import { OpenAiLlmProvider } from "./openAiProvider";

export function buildLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const choice = (env.LLM_PROVIDER ?? "mock").toLowerCase();
  switch (choice) {
    case "mock":
      return new MockLlmProvider();
    case "openai": {
      const apiKey = env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "LLM_PROVIDER=openai requires OPENAI_API_KEY to be set in the environment",
        );
      }
      return new OpenAiLlmProvider({ apiKey, model: env.OPENAI_MODEL });
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${choice}`);
  }
}
