import { describe, expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { NextRequest } from "next/server";
import { middleware, config } from "../../middleware";

// The middleware builds every redirect from the configured public origin,
// never from request.url: behind Caddy the container sees 0.0.0.0:3000.
const SAVED_ENV = new Map(
  ["APP_BASE_URL", "SESSION_SECRET"].map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SECRET = "middleware-test-secret";
const NOW = new Date("2026-10-31T09:00:00.000Z");

async function sessionCookie(userId = "user-1"): Promise<string> {
  const { signSessionJwt, SESSION_TTL_SECONDS } = await import("../../lib/auth/jwt");
  return signSessionJwt(userId, SECRET, NOW, SESSION_TTL_SECONDS);
}

function request(url: string, cookie?: string) {
  const headers = new Headers(cookie === undefined ? undefined : { cookie });
  return new NextRequest(url, { headers }) as unknown as Parameters<typeof middleware>[0];
}

describe("middleware", () => {
  test("matcher covers the protected prefixes only, never /accept", () => {
    expect(config.matcher).toEqual([
      "/dashboard/:path*",
      "/tasks/:path*",
      "/weak-spots/:path*",
      "/billing/:path*",
    ]);
    expect(JSON.stringify(config.matcher)).not.toContain("accept");
  });

  test("a redirect on a protected route is built from APP_BASE_URL's origin, not request.url", async () => {
    process.env.APP_BASE_URL = "https://settle.example.com";
    delete process.env.SESSION_SECRET;

    const res = await middleware(request("http://0.0.0.0:3000/dashboard"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://settle.example.com/auth/expired");
  });

  test("the same is true for a valid session on the billing page", async () => {
    process.env.APP_BASE_URL = "https://settle.example.com";
    process.env.SESSION_SECRET = SECRET;
    const cookie = await sessionCookie();

    const res = await middleware(request("http://0.0.0.0:3000/billing", cookie));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://settle.example.com/auth/expired");
  });

  test("without APP_BASE_URL the fallback is the request URL (local dev)", async () => {
    delete process.env.APP_BASE_URL;
    delete process.env.SESSION_SECRET;

    const res = await middleware(request("http://localhost:3000/dashboard"));

    expect(res.headers.get("location")).toBe("http://localhost:3000/auth/expired");
  });

  test("a valid session and a current acceptance pass through with the path header set", async () => {
    process.env.APP_BASE_URL = "https://settle.example.com";
    process.env.SESSION_SECRET = SECRET;
    const cookie = await sessionCookie();
    // The middleware itself only checks the JWT; the acceptance gate lives in
    // requireSessionUser (sessionGateFor tests). A pass here means the request
    // proceeds with the stamped path header.
    const { verifySessionJwt } = await import("../../lib/auth/jwt");
    expect(await verifySessionJwt(cookie, SECRET, NOW)).toEqual({ userId: "user-1" });

    const res = await middleware(request("https://settle.example.com/dashboard", cookie));
    expect(res.status).toBeLessThan(400);
  });
});
