import { describe, expect, test } from "bun:test";
import { handleMagicLink } from "../../lib/auth/login-route";

const RAW = "a".repeat(43);
const ORIGIN = "https://settle.example.com";
const LOCAL_ORIGIN = "http://localhost:3000";

type MagicLinkDeps = Parameters<typeof handleMagicLink>[1];

function makeDeps(
  redeemResult: { userId: string } | null,
  origin: string = ORIGIN,
): { deps: MagicLinkDeps; redeemCalls: string[]; sessionCalls: string[] } {
  const redeemCalls: string[] = [];
  const sessionCalls: string[] = [];
  return {
    redeemCalls,
    sessionCalls,
    deps: {
      redeem: async (raw) => {
        redeemCalls.push(raw);
        return redeemResult;
      },
      createSession: async (userId) => {
        sessionCalls.push(userId);
        return `jwt-for-${userId}`;
      },
      origin,
    },
  };
}

describe("handleMagicLink (app/auth/[token] GET logic)", () => {
  test("valid token: 303 to the dashboard with the session cookie set", async () => {
    const { deps, redeemCalls, sessionCalls } = makeDeps({ userId: "user-1" });

    const res = await handleMagicLink(RAW, deps);

    expect(redeemCalls).toEqual([RAW]);
    expect(sessionCalls).toEqual(["user-1"]);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://settle.example.com/dashboard");

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("settle_session=jwt-for-user-1");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=604800");
    // https origin means the Secure attribute is on.
    expect(cookie).toContain("Secure");

    // Both headers guard the single use token against caches and referrers.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    // The token must not be echoed anywhere in the response.
    expect(res.headers.get("Location")).not.toContain(RAW);
    expect(cookie).not.toContain(RAW);
  });

  test("invalid, used or expired token: 303 to the expired page with no cookie", async () => {
    const { deps, sessionCalls } = makeDeps(null);

    const res = await handleMagicLink("bad-or-used-token", deps);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://settle.example.com/auth/expired");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(sessionCalls).toEqual([]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("a localhost redirect keeps the cookie non Secure so local dev works", async () => {
    const { deps } = makeDeps({ userId: "user-1" }, LOCAL_ORIGIN);

    const res = await handleMagicLink(RAW, deps);

    expect(res.headers.get("Location")).toBe("http://localhost:3000/dashboard");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("settle_session=jwt-for-user-1");
    expect(cookie).not.toContain("Secure");
  });
});
