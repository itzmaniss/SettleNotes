import { describe, expect, test } from "bun:test";
import {
  performAccept,
  resolveAcceptVisitor,
  type AcceptDeps,
} from "../../lib/auth/accept";
import type { UpsertUserInput } from "../../lib/db/queries";
import type { UserRow } from "../../lib/db/types";
import { hasAcceptedCurrentTerms } from "../../lib/legal/consent";
import { TERMS_VERSION } from "../../lib/legal/version";
import { createConsentToken } from "../../lib/auth/consent-cookie";
import { signSessionJwt, SESSION_TTL_SECONDS } from "../../lib/auth/jwt";

const SECRET = "test-accept-secret-16ch";
const BASE = "https://settle.example.com";
const NOW = new Date("2026-10-31T09:00:00.000Z");
const TID = 900000001;

function acceptedRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "row-1",
    telegram_user_id: TID,
    telegram_chat_id: 555000,
    first_name: "Tim",
    timezone: "Asia/Singapore",
    terms_accepted_at: NOW.toISOString(),
    terms_version: TERMS_VERSION,
    created_at: "2026-10-01T01:00:00.000Z",
    ...overrides,
  };
}

function staleRow(): UserRow {
  return acceptedRow({ terms_accepted_at: "2026-01-01T00:00:00.000Z", terms_version: "2020-01-01" });
}

type DepsSpy = {
  deps: AcceptDeps;
  upserts: UpsertUserInput[];
  byTelegramLookups: number[];
  byIdLookups: string[];
  sessionCalls: string[];
};

function makeDeps(
  opts: {
    byTelegram?: UserRow | null | Error;
    byId?: UserRow | null | Error;
  } = {},
): DepsSpy {
  const upserts: UpsertUserInput[] = [];
  const byTelegramLookups: number[] = [];
  const byIdLookups: string[] = [];
  const sessionCalls: string[] = [];
  const deps: AcceptDeps = {
    secret: SECRET,
    appBaseUrl: BASE,
    getUserByTelegramId: async (tid) => {
      byTelegramLookups.push(tid);
      if (opts.byTelegram instanceof Error) throw opts.byTelegram;
      return opts.byTelegram ?? null;
    },
    getUserById: async (id) => {
      byIdLookups.push(id);
      if (opts.byId instanceof Error) throw opts.byId;
      return opts.byId ?? null;
    },
    upsertUser: async (input) => {
      upserts.push(input);
      return acceptedRow({ telegram_user_id: input.telegramUserId });
    },
    createSessionToken: async (userId) => {
      sessionCalls.push(userId);
      return `jwt-for-${userId}`;
    },
    now: () => NOW,
  };
  return { deps, upserts, byTelegramLookups, byIdLookups, sessionCalls };
}

async function consentToken(): Promise<string> {
  return createConsentToken({ tid: TID, fn: "Wei" }, SECRET, NOW);
}

async function sessionToken(userId: string): Promise<string> {
  return signSessionJwt(userId, SECRET, NOW, SESSION_TTL_SECONDS);
}

describe("resolveAcceptVisitor", () => {
  test("a valid consent cookie wins and carries the claims", async () => {
    const { deps } = makeDeps();
    const visitor = await resolveAcceptVisitor(deps, { consentToken: await consentToken() });
    expect(visitor).toEqual({ kind: "consent", claims: { tid: TID, fn: "Wei" } });
  });

  test("no cookies at all resolves to null", async () => {
    const { deps } = makeDeps();
    expect(await resolveAcceptVisitor(deps, {})).toBeNull();
    expect(await resolveAcceptVisitor(deps, { consentToken: null, sessionToken: null })).toBeNull();
  });

  test("a tampered or foreign consent cookie falls through to the session check", async () => {
    const { deps } = makeDeps({ byId: staleRow() });
    expect(
      await resolveAcceptVisitor(deps, { consentToken: "garbage", sessionToken: await sessionToken("row-1") }),
    ).toEqual({ kind: "session", row: staleRow() });
  });

  test("a session whose user already accepted resolves to accepted", async () => {
    const { deps } = makeDeps({ byId: acceptedRow() });
    const visitor = await resolveAcceptVisitor(deps, { sessionToken: await sessionToken("row-1") });
    expect(visitor).toEqual({ kind: "accepted" });
  });

  test("a session whose user is stale or unaccepted resolves to session", async () => {
    const { deps } = makeDeps({ byId: staleRow() });
    const visitor = await resolveAcceptVisitor(deps, { sessionToken: await sessionToken("row-1") });
    expect(visitor?.kind).toBe("session");
  });

  test("a session pointing at a deleted row fails closed as anonymous", async () => {
    const { deps } = makeDeps({ byId: null });
    expect(await resolveAcceptVisitor(deps, { sessionToken: await sessionToken("gone") })).toBeNull();
  });

  test("a session signed with the wrong secret is anonymous", async () => {
    const foreign = await signSessionJwt("row-1", "another-secret-16chr", NOW, SESSION_TTL_SECONDS);
    const { deps } = makeDeps({ byId: acceptedRow() });
    expect(await resolveAcceptVisitor(deps, { sessionToken: foreign })).toBeNull();
  });
});

describe("performAccept (the server action core)", () => {
  test("consent cookie, new user: row created with chat id = telegram id and both terms fields", async () => {
    const { deps, upserts, sessionCalls } = makeDeps({ byTelegram: null });
    const outcome = await performAccept(deps, { consentToken: await consentToken(), next: "/billing" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location).toBe("/billing");
    expect(outcome.clearConsentCookie).toBe(true);
    expect(outcome.sessionToken).toBe("jwt-for-row-1");
    expect(upserts).toEqual([
      {
        telegramUserId: TID,
        telegramChatId: TID,
        firstName: "Wei",
        termsAcceptedAt: NOW,
        termsVersion: TERMS_VERSION,
      },
    ]);
    expect(sessionCalls).toEqual(["row-1"]);
  });

  test("consent cookie, existing stale row: the chat id and name are kept, only terms are written", async () => {
    const { deps, upserts } = makeDeps({ byTelegram: staleRow() });
    const outcome = await performAccept(deps, { consentToken: await consentToken() });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location).toBe("/dashboard");
    expect(upserts).toEqual([
      {
        telegramUserId: TID,
        telegramChatId: 555000,
        firstName: "Wei",
        termsAcceptedAt: NOW,
        termsVersion: TERMS_VERSION,
      },
    ]);
  });

  test("session case: only the terms columns are written for the session user, no new session", async () => {
    const { deps, upserts, sessionCalls } = makeDeps({ byId: staleRow() });
    const outcome = await performAccept(deps, { sessionToken: await sessionToken("row-1"), next: "/tasks" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.location).toBe("/tasks");
    expect(outcome.sessionToken).toBeNull();
    expect(outcome.clearConsentCookie).toBe(false);
    expect(upserts).toEqual([
      {
        telegramUserId: TID,
        telegramChatId: 555000,
        firstName: "Tim",
        termsAcceptedAt: NOW,
        termsVersion: TERMS_VERSION,
      },
    ]);
    expect(sessionCalls).toEqual([]);
  });

  test("an already accepted session user is sent to the dashboard with no write", async () => {
    const { deps, upserts } = makeDeps({ byId: acceptedRow() });
    const outcome = await performAccept(deps, { sessionToken: await sessionToken("row-1") });

    expect(outcome).toEqual({ kind: "ok", location: "/dashboard", sessionToken: null, clearConsentCookie: false });
    expect(upserts).toEqual([]);
  });

  test("nothing valid presented: anonymous, no write at all", async () => {
    const { deps, upserts } = makeDeps();
    expect(await performAccept(deps, { next: "/billing" })).toEqual({ kind: "anonymous" });
    expect(upserts).toEqual([]);
  });

  test("open redirect attempts in next fall back to the dashboard", async () => {
    const { deps } = makeDeps({ byTelegram: null });
    for (const evil of ["//evil.com", "https://evil.com", "/\\evil", "/dashboard/../x", "tasks", "/login", "/not-allowed"]) {
      const outcome = await performAccept(deps, { consentToken: await consentToken(), next: evil });
      expect(outcome.kind === "ok" ? outcome.location : outcome, `next ${evil}`).toBe("/dashboard");
    }
  });

  test("the recorded acceptance passes hasAcceptedCurrentTerms", async () => {
    const { deps } = makeDeps({ byTelegram: null });
    const outcome = await performAccept(deps, { consentToken: await consentToken() });
    if (outcome.kind !== "ok") return;
    expect(
      hasAcceptedCurrentTerms({ terms_accepted_at: NOW.toISOString(), terms_version: TERMS_VERSION }),
    ).toBe(true);
  });
});
