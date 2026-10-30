import { describe, expect, test } from "bun:test";
import { isRecurring, weakSpotPips } from "@/lib/dashboard/weak-spots";

describe("weakSpotPips", () => {
  test("one occurrence: one of three segments", () => {
    expect(weakSpotPips(1)).toEqual({ segments: 3, filled: 1 });
  });

  test("exactly recurring: all three filled", () => {
    expect(weakSpotPips(3)).toEqual({ segments: 3, filled: 3 });
  });

  test("capped at five segments", () => {
    expect(weakSpotPips(5)).toEqual({ segments: 5, filled: 5 });
    expect(weakSpotPips(9)).toEqual({ segments: 5, filled: 5 });
  });

  test("never negative", () => {
    expect(weakSpotPips(0)).toEqual({ segments: 3, filled: 0 });
  });
});

describe("isRecurring", () => {
  test("recurring from three occurrences", () => {
    expect(isRecurring(1)).toBe(false);
    expect(isRecurring(2)).toBe(false);
    expect(isRecurring(3)).toBe(true);
    expect(isRecurring(7)).toBe(true);
  });
});
