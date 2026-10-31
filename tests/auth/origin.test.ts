import { describe, expect, test } from "bun:test";
import { publicOrigin } from "../../lib/auth/origin";

describe("publicOrigin", () => {
  test("decision table", () => {
    const cases: Array<[string | undefined, string, string]> = [
      // https base wins over the container's internal host
      ["https://settle.example.com", "http://0.0.0.0:3000/login", "https://settle.example.com"],
      // http base is still the configured origin (local dev)
      ["http://localhost:3000", "http://0.0.0.0:3000/login", "http://localhost:3000"],
      // a base with a path still resolves to its origin
      ["https://settle.example.com/app/", "http://0.0.0.0:3000/x", "https://settle.example.com"],
      // surrounding whitespace is trimmed before parsing
      ["  https://settle.example.com  ", "http://0.0.0.0:3000/x", "https://settle.example.com"],
      // undefined base falls back to the request URL
      [undefined, "http://0.0.0.0:3000/login", "http://0.0.0.0:3000"],
      [undefined, "https://fallback.test/a/b?c=1", "https://fallback.test"],
      // empty and garbage bases fall back to the request URL
      ["", "https://fallback.test/x", "https://fallback.test"],
      ["not a url", "https://fallback.test/x", "https://fallback.test"],
      ["http://", "https://fallback.test/x", "https://fallback.test"],
      // a good base wins even when the request URL is garbage
      ["https://settle.example.com", "garbage", "https://settle.example.com"],
    ];
    for (const [base, requestUrl, expected] of cases) {
      expect(publicOrigin(base, requestUrl), `base ${JSON.stringify(base)}`).toBe(expected);
    }
  });

  test("both unparseable hands back the raw fallback so the caller fails the same way it would have", () => {
    expect(publicOrigin("garbage", "still not a url")).toBe("still not a url");
  });
});
