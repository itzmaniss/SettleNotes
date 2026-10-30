import { describe, expect, test } from "bun:test";
import type { CreateLoginTokenInput } from "../../lib/db/queries";
import {
  LOGIN_TOKEN_TTL_MS,
  RAW_TOKEN_LENGTH,
  generateLoginToken,
  hashLoginToken,
  issueLoginLink,
  redeemLoginToken,
} from "../../lib/auth/tokens";

const NOW = new Date("2026-10-31T09:00:00.000Z");
const RAW = "a".repeat(RAW_TOKEN_LENGTH);

describe("generateLoginToken", () => {
  test("raw is 43 base64url characters, hash is sha256 hex and differs from raw", () => {
    const { raw, hash } = generateLoginToken();
    expect(raw).toHaveLength(43);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(raw);
  });

  test("two tokens never collide and each hash matches its own raw", () => {
    const first = generateLoginToken();
    const second = generateLoginToken();
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).toBe(hashLoginToken(first.raw));
    expect(second.hash).toBe(hashLoginToken(second.raw));
  });
});

describe("issueLoginLink", () => {
  test("stores only the hash with a 15 minute expiry; the URL carries the raw token", async () => {
    const stored: CreateLoginTokenInput[] = [];
    const random = () => Buffer.alloc(32, 7);
    const expectedRaw = Buffer.alloc(32, 7).toString("base64url");

    const link = await issueLoginLink("user-1", {
      createLoginToken: async (i) => {
        stored.push(i);
      },
      now: () => NOW,
      random,
      appBaseUrl: "https://settle.example.com",
    });

    expect(link).toBe(`https://settle.example.com/auth/${expectedRaw}`);
    expect(stored).toHaveLength(1);
    expect(stored[0].userId).toBe("user-1");
    expect(stored[0].tokenHash).toBe(hashLoginToken(expectedRaw));
    expect(stored[0].expiresAt.getTime()).toBe(NOW.getTime() + LOGIN_TOKEN_TTL_MS);
    // The stored row must never contain the raw token, even by accident.
    expect(JSON.stringify(stored)).not.toContain(expectedRaw);
    expect(link).toContain(expectedRaw);
  });

  test("a trailing slash on the base URL does not double up", async () => {
    const link = await issueLoginLink("user-1", {
      createLoginToken: async () => {},
      now: () => NOW,
      random: () => Buffer.alloc(32, 7),
      appBaseUrl: "http://localhost:3000/",
    });
    expect(link).toBe(`http://localhost:3000/auth/${Buffer.alloc(32, 7).toString("base64url")}`);
  });
});

describe("redeemLoginToken", () => {
  function makeConsume(entries: Array<{ hash: string; userId: string; expiresAt: Date }>) {
    let calls = 0;
    const consume = async (hash: string, now: Date) => {
      calls += 1;
      const row = entries.find((entry) => entry.hash === hash);
      if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
      // Single use: drop the entry on first success so a second call fails.
      entries.splice(entries.indexOf(row), 1);
      return { userId: row.userId };
    };
    return { consume, calls: () => calls };
  }

  function store(raw: string, expiresAt: Date, userId = "user-9") {
    return [{ hash: hashLoginToken(raw), userId, expiresAt }];
  }

  test("success once, reuse is rejected", async () => {
    const entries = store(RAW, new Date(NOW.getTime() + LOGIN_TOKEN_TTL_MS));
    const { consume, calls } = makeConsume(entries);

    const first = await redeemLoginToken(RAW, { consumeLoginToken: consume, now: () => NOW });
    expect(first).toEqual({ userId: "user-9" });

    const second = await redeemLoginToken(RAW, { consumeLoginToken: consume, now: () => NOW });
    expect(second).toBeNull();
    expect(calls()).toBe(2);
  });

  test("expired tokens are rejected", async () => {
    const entries = store(RAW, new Date(NOW.getTime() - 1));
    const { consume, calls } = makeConsume(entries);

    const result = await redeemLoginToken(RAW, { consumeLoginToken: consume, now: () => NOW });
    expect(result).toBeNull();
    expect(calls()).toBe(1);
  });

  test("malformed input returns null without touching the DB", async () => {
    const entries = store("a".repeat(43), new Date(NOW.getTime() + LOGIN_TOKEN_TTL_MS));
    const { consume, calls } = makeConsume(entries);

    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `a${"+".repeat(42)}`, `${"/".repeat(43)}`, `${"a".repeat(42)}=`]) {
      const result = await redeemLoginToken(bad, { consumeLoginToken: consume, now: () => NOW });
      expect(result).toBeNull();
    }
    expect(calls()).toBe(0);
  });
});
