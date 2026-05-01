import {
  type AnalysisResult,
  type LlmProvider,
  type LlmRawResponse,
  LlmTransportError,
} from "./types";

// Deterministic mock provider. Used by default and in tests so the project
// runs with zero configuration and so we can reliably exercise FAILED paths.
//
// Magic tokens recognised in the input:
//   __FAIL_TRANSPORT__   -> throws LlmTransportError (worker should retry once)
//   __FAIL_INVALID_JSON__ -> returns text that is not JSON
//   __FAIL_SCHEMA__      -> returns valid JSON that violates the schema
//                           (confidence as string)
//   __FAIL_TIMEOUT__     -> sleeps longer than any reasonable timeout so the
//                           worker's AbortSignal triggers
//
// Otherwise the mock heuristically classifies sentiment and extracts a single
// feature request when the word "should", "would like" or "wish" appears.
export class MockLlmProvider implements LlmProvider {
  public readonly name = "mock";

  public async analyze(
    content: string,
    opts: { signal: AbortSignal },
  ): Promise<LlmRawResponse> {
    if (content.includes("__FAIL_TRANSPORT__")) {
      throw new LlmTransportError("mock: simulated transport failure");
    }
    if (content.includes("__FAIL_TIMEOUT__")) {
      await sleepUntilAborted(opts.signal);
      throw new LlmTransportError("mock: signal aborted");
    }
    if (content.includes("__FAIL_INVALID_JSON__")) {
      return { raw: "this is not json {{{" };
    }
    if (content.includes("__FAIL_SCHEMA__")) {
      return {
        raw: JSON.stringify({
          sentiment: "positive",
          feature_requests: [{ title: "x", confidence: "high" }],
          actionable_insight: "n/a",
        }),
      };
    }

    const result = synthesize(content);
    return { raw: JSON.stringify(result) };
  }
}

function synthesize(content: string): AnalysisResult {
  const lower = content.toLowerCase();
  const sentiment: AnalysisResult["sentiment"] = (() => {
    const negativeHits = countMatches(lower, [
      "bad",
      "terrible",
      "broken",
      "hate",
      "awful",
      "slow",
      "bug",
      "crash",
      "annoying",
    ]);
    const positiveHits = countMatches(lower, [
      "love",
      "great",
      "awesome",
      "amazing",
      "excellent",
      "good",
      "fast",
      "nice",
    ]);
    if (negativeHits > positiveHits) return "negative";
    if (positiveHits > negativeHits) return "positive";
    return "neutral";
  })();

  const featureRequests: AnalysisResult["feature_requests"] = [];
  const requestSignals = ["should", "would like", "wish", "please add", "could you"];
  for (const signal of requestSignals) {
    const idx = lower.indexOf(signal);
    if (idx === -1) continue;
    const fragment = content.slice(idx, idx + 80).split(/[.!?\n]/)[0]?.trim();
    if (fragment && fragment.length > 0) {
      featureRequests.push({
        title: truncate(fragment, 80),
        confidence: 0.6,
      });
      break;
    }
  }

  const actionableInsight =
    sentiment === "negative"
      ? "Investigate the reported issue and follow up with the user."
      : sentiment === "positive"
        ? "Capture this positive signal; consider amplifying the praised behavior."
        : "No immediate action required; monitor for related feedback.";

  return {
    sentiment,
    feature_requests: featureRequests,
    actionable_insight: actionableInsight,
  };
}

function countMatches(haystack: string, needles: string[]): number {
  return needles.reduce((acc, n) => acc + (haystack.includes(n) ? 1 : 0), 0);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function sleepUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
