import { describe, expect, test } from 'bun:test';
import { SPARK_PRICE_PER_MTOK, TRANSCRIBE_PRICE_PER_HOUR, sparkCostUsd, transcribeCostUsd } from '../../lib/meta/pricing';

describe('pricing', () => {
  test('price table matches docs/meta-api/pricing-rate-limits.md', () => {
    expect(SPARK_PRICE_PER_MTOK).toEqual({ input: 1.25, cachedInput: 0.15, output: 4.25 });
    expect(TRANSCRIBE_PRICE_PER_HOUR).toBe(0.18);
  });

  test('sparkCostUsd splits uncached and cached input tokens', () => {
    // 2M uncached input, 1M cached input, 1.5M output
    // = 2 * 1.25 + 1 * 0.15 + 1.5 * 4.25 = 9.025
    expect(sparkCostUsd({ inputTokens: 3_000_000, cachedTokens: 1_000_000, outputTokens: 1_500_000 })).toBe(9.025);
  });

  test('sparkCostUsd with zero cache treats all input as uncached', () => {
    expect(sparkCostUsd({ inputTokens: 3000, cachedTokens: 0, outputTokens: 1500 })).toBe(0.010125);
  });

  test('sparkCostUsd never bills negative uncached input', () => {
    expect(sparkCostUsd({ inputTokens: 100, cachedTokens: 500, outputTokens: 0 })).toBe(
      sparkCostUsd({ inputTokens: 100, cachedTokens: 100, outputTokens: 0 }),
    );
  });

  test('transcribeCostUsd bills by the hour of audio', () => {
    expect(transcribeCostUsd(3600)).toBe(0.18);
    expect(transcribeCostUsd(1800)).toBe(0.09);
    expect(transcribeCostUsd(60)).toBeCloseTo(0.003, 6);
    expect(transcribeCostUsd(0)).toBe(0);
  });
});
