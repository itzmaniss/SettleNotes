import { describe, expect, test } from "bun:test";
import {
  EXPIRED_PATH,
  POST_LOGIN_PATH,
  PROTECTED_PREFIXES,
  isProtectedPath,
} from "../../lib/auth/paths";

describe("isProtectedPath", () => {
  test("prefix match on segment boundary", () => {
    const cases: Array<[string, boolean]> = [
      ["/dashboard", true],
      ["/dashboard/", true],
      ["/dashboard/tasks/12", true],
      ["/dashboards", false],
      ["/dashboardx", false],
      ["/tasks", true],
      ["/tasks/123", true],
      ["/tasksheet", false],
      ["/weak-spots", true],
      ["/weak-spots/w-1", true],
      ["/weak-spotsies", false],
      ["/billing", true],
      ["/billing/", true],
      ["/billing/invoice-1", true],
      ["/billingpage", false],
      ["/", false],
      ["", false],
      ["/api/telegram", false],
      ["/auth/abc", false],
      ["/auth/expired", false],
    ];
    for (const [pathname, expected] of cases) {
      expect(isProtectedPath(pathname)).toBe(expected);
    }
  });

  test("constants match the spec", () => {
    expect(POST_LOGIN_PATH).toBe("/dashboard");
    expect(EXPIRED_PATH).toBe("/auth/expired");
    expect(PROTECTED_PREFIXES).toEqual(["/dashboard", "/tasks", "/weak-spots", "/billing"]);
  });
});
