import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { consumeLoginToken, createLoginToken } from "@/lib/db/queries";
import type { CreateLoginTokenInput } from "@/lib/db/queries";
import { env } from "@/lib/env";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

// 32 random bytes encoded as base64url are always exactly 43 characters, so
// anything else is garbage and never reaches the DB.
export const RAW_TOKEN_LENGTH = 43;
const RAW_TOKEN_BYTES = 32;
const RAW_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${RAW_TOKEN_LENGTH}}$`);

export function generateLoginToken(): { raw: string; hash: string } {
  const raw = randomBytes(RAW_TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashLoginToken(raw) };
}

export function hashLoginToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export type IssueLoginLinkDeps = {
  createLoginToken?: (i: CreateLoginTokenInput) => Promise<void>;
  now?: () => Date;
  random?: () => Buffer;
  appBaseUrl?: string;
};

// Stores only the sha256 of the raw token; the raw value exists solely in the
// returned link. Real deps are the lib/db/queries helpers, resolved at call
// time so importing this module never touches the database or env.
export async function issueLoginLink(
  userId: string,
  deps: IssueLoginLinkDeps = {},
): Promise<string> {
  const bytes = deps.random ? deps.random() : randomBytes(RAW_TOKEN_BYTES);
  const raw = bytes.toString("base64url");
  const now = (deps.now ?? (() => new Date()))();
  const store = deps.createLoginToken ?? createLoginToken;
  await store({
    userId,
    tokenHash: hashLoginToken(raw),
    expiresAt: new Date(now.getTime() + LOGIN_TOKEN_TTL_MS),
  });
  const base = (deps.appBaseUrl ?? env.APP_BASE_URL).replace(/\/+$/, "");
  return `${base}/auth/${raw}`;
}

export type RedeemLoginTokenDeps = {
  consumeLoginToken?: (hash: string, now: Date) => Promise<{ userId: string } | null>;
  now?: () => Date;
};

// Hashes the raw token and hands it to the single use, atomic
// consumeLoginToken. Null means unknown, expired, already used or malformed.
export async function redeemLoginToken(
  raw: string,
  deps: RedeemLoginTokenDeps = {},
): Promise<{ userId: string } | null> {
  if (!RAW_TOKEN_PATTERN.test(raw)) return null;
  const consume = deps.consumeLoginToken ?? consumeLoginToken;
  const now = (deps.now ?? (() => new Date()))();
  return consume(hashLoginToken(raw), now);
}
