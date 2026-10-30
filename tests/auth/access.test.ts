import { describe, expect, test } from "bun:test";
import { MIN_SESSION_SECRET_LENGTH, decideAccess } from "../../lib/auth/access";
import { SESSION_TTL_SECONDS, signSessionJwt } from "../../lib/auth/jwt";

const NOW = new Date("2026-10-31T09:00:00.000Z");
const SECRET = "s".repeat(16);

async function validToken(): Promise<string> {
  return signSessionJwt("user-1", SECRET, NOW, SESSION_TTL_SECONDS);
}

describe("decideAccess", () => {
  test("no cookie on a protected path redirects", async () => {
    expect(await decideAccess("/dashboard", undefined, SECRET, NOW)).toBe("redirect");
    expect(await decideAccess("/dashboard", null, SECRET, NOW)).toBe("redirect");
    expect(await decideAccess("/dashboard", "", SECRET, NOW)).toBe("redirect");
    expect(await decideAccess("/dashboard", "not-a-jwt", SECRET, NOW)).toBe("redirect");
  });

  test("a valid session cookie on a protected path allows", async () => {
    const token = await validToken();
    expect(await decideAccess("/dashboard", token, SECRET, NOW)).toBe("allow");
    expect(await decideAccess("/dashboard/tasks/12", token, SECRET, NOW)).toBe("allow");
    expect(await decideAccess("/weak-spots", token, SECRET, NOW)).toBe("allow");
  });

  test("an expired session redirects", async () => {
    const token = await validToken();
    const later = new Date(NOW.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);
    expect(await decideAccess("/dashboard", token, SECRET, later)).toBe("redirect");
  });

  test("a missing, empty or short secret fails closed", async () => {
    const token = await validToken();
    expect(await decideAccess("/dashboard", token, undefined, NOW)).toBe("redirect");
    expect(await decideAccess("/dashboard", token, "", NOW)).toBe("redirect");
    expect(await decideAccess("/dashboard", token, "s".repeat(15), NOW)).toBe("redirect");
    expect(MIN_SESSION_SECRET_LENGTH).toBe(16);
  });

  test("unprotected paths allow without touching the session", async () => {
    for (const pathname of ["/", "/auth/abc", "/auth/expired", "/api/telegram", "/dashboards"]) {
      expect(await decideAccess(pathname, undefined, undefined, NOW)).toBe("allow");
    }
  });
});
