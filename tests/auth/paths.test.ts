import { describe, expect, test } from "bun:test";
import {
  ACCEPT_PATH,
  EXPIRED_PATH,
  POST_LOGIN_PATH,
  PROTECTED_PREFIXES,
  REQUEST_PATH_HEADER,
  acceptRedirectPath,
  isProtectedPath,
  safeNextPath,
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
      ["/account", true],
      ["/account/", true],
      ["/account/export", true],
      ["/account-deleted", false],
      ["/accounts", false],
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
    expect(PROTECTED_PREFIXES).toEqual([
      "/dashboard",
      "/tasks",
      "/weak-spots",
      "/billing",
      "/account",
    ]);
  });
});

describe("safeNextPath and acceptRedirectPath", () => {
  test("ACCEPT_PATH is the public acceptance page", () => {
    expect(ACCEPT_PATH).toBe("/accept");
    // It must never sit behind the session gate.
    expect(isProtectedPath(ACCEPT_PATH)).toBe(false);
    for (const prefix of PROTECTED_PREFIXES) {
      expect(ACCEPT_PATH.startsWith(prefix)).toBe(false);
    }
  });

  test("acceptRedirectPath with a known next keeps it on /accept", () => {
    expect(acceptRedirectPath("/billing")).toBe("/accept?next=%2Fbilling");
    expect(acceptRedirectPath("/tasks/12")).toBe("/accept?next=%2Ftasks%2F12");
  });

  test("acceptRedirectPath without a next uses the bare page; a bad next falls back to the dashboard", () => {
    expect(acceptRedirectPath()).toBe("/accept");
    expect(acceptRedirectPath(null)).toBe("/accept");
    expect(acceptRedirectPath("")).toBe("/accept");
    // safeNextPath's fallback flows through, so the person still ends up on
    // the dashboard after accepting.
    expect(acceptRedirectPath("//evil.com")).toBe("/accept?next=%2Fdashboard");
    expect(acceptRedirectPath("/login")).toBe("/accept?next=%2Fdashboard");
  });

  test("safeNextPath: open redirect surface", () => {
    expect(safeNextPath("/billing")).toBe("/billing");
    for (const evil of ["//evil.com", "https://evil.com", "/\\evil", "/dashboard/../x", "tasks", "", null, undefined]) {
      expect(safeNextPath(evil), `next ${JSON.stringify(evil)}`).toBe("/dashboard");
    }
  });

  test("the request path header constant is a private header name", () => {
    expect(REQUEST_PATH_HEADER).toBe("x-settle-path");
  });
});
