// Price table for Meta Model API, Standard mode, per docs/meta-api/pricing-rate-limits.md.
// Token prices are per 1M tokens ("MTOK"). Transcribe is billed by the hour of
// audio processed, metered in whole seconds.

export const SPARK_PRICE_PER_MTOK = {
  input: 1.25,
  cachedInput: 0.15,
  output: 4.25,
} as const;

export const TRANSCRIBE_PRICE_PER_HOUR = 0.18;

// usage.input_tokens as reported INCLUDES the cached tokens, so uncached =
// input - cached. Output tokens include reasoning tokens at the same rate.
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function sparkCostUsd(u: { inputTokens: number; cachedTokens: number; outputTokens: number }): number {
  // cached is a subset of input; clamp defensively so an inconsistent usage
  // object can never bill more cached tokens than were reported as input.
  const cached = Math.min(u.cachedTokens, u.inputTokens);
  const uncachedInput = u.inputTokens - cached;
  const cost =
    (uncachedInput / 1e6) * SPARK_PRICE_PER_MTOK.input +
    (cached / 1e6) * SPARK_PRICE_PER_MTOK.cachedInput +
    (u.outputTokens / 1e6) * SPARK_PRICE_PER_MTOK.output;
  return round6(cost);
}

export function transcribeCostUsd(seconds: number): number {
  return round6((seconds / 3600) * TRANSCRIBE_PRICE_PER_HOUR);
}
