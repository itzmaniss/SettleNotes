import { afterEach, describe, expect, test } from "bun:test";
import { isBillingEnabled } from "../../lib/billing/flags";

const KEY = "BILLING_ENABLED";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = original;
  }
});

describe("isBillingEnabled", () => {
  test("false when unset", () => {
    delete process.env[KEY];
    expect(isBillingEnabled()).toBe(false);
  });

  test("false for any value that is not exactly 'true'", () => {
    for (const value of ["false", "", "1", "TRUE", "true ", " true"]) {
      process.env[KEY] = value;
      expect(isBillingEnabled()).toBe(false);
    }
  });

  test("true only for 'true'", () => {
    process.env[KEY] = "true";
    expect(isBillingEnabled()).toBe(true);
  });
});
