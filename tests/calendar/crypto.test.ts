import { describe, expect, test } from "bun:test";
import { decryptToken, encryptToken } from "../../lib/calendar/crypto";

const KEY_32 = Buffer.from("a".repeat(32)).toString("base64");

describe("calendar crypto", () => {
  test("roundtrip restores the plaintext", () => {
    const blob = encryptToken("refresh-token-secret", KEY_32);
    expect(decryptToken(blob, KEY_32)).toBe("refresh-token-secret");
  });

  test("blob is versioned with four base64url parts", () => {
    const blob = encryptToken("x", KEY_32);
    const parts = blob.split(".");
    expect(parts[0]).toBe("v1");
    expect(parts).toHaveLength(4);
    expect(blob).not.toMatch(/[+/=]/);
  });

  test("two encryptions differ (random IV)", () => {
    expect(encryptToken("same", KEY_32)).not.toBe(encryptToken("same", KEY_32));
  });

  test("wrong key fails to decrypt", () => {
    const blob = encryptToken("secret", KEY_32);
    const other = Buffer.from("b".repeat(32)).toString("base64");
    expect(() => decryptToken(blob, other)).toThrow();
  });

  test("tampered blob fails to decrypt", () => {
    const parts = encryptToken("secret", KEY_32).split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
    expect(() => decryptToken(parts.join("."), KEY_32)).toThrow();
  });

  test("malformed blob fails with a clear error", () => {
    expect(() => decryptToken("not-a-blob", KEY_32)).toThrow(/malformed/);
    expect(() => decryptToken("v2.a.b.c", KEY_32)).toThrow(/malformed/);
  });

  test("bad key length throws a clear error on both ends", () => {
    const short = Buffer.from("short").toString("base64");
    expect(() => encryptToken("x", short)).toThrow(/32 bytes/);
    expect(() => decryptToken("v1.a.b.c", short)).toThrow(/32 bytes/);
    expect(() => encryptToken("x", "!!!not-base64!!!")).toThrow(/32 bytes/);
  });
});
