import "server-only";
import { getSessionUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/queries";
import { getSupabase } from "@/lib/db/client";
import { env } from "@/lib/env";
import { buildExport, type PrivacyExport } from "@/lib/privacy/export";
import { createExportRateLimiter, type ExportRateLimiter } from "./rate-limit";
import { EXPORT_RATE_LIMIT_LINE } from "./web-copy";

// The logic behind app/(dashboard)/account/export/route.ts, kept here so
// tests run on injected fakes; the route file stays a thin wrapper. The user
// id comes only from the signed session: the request URL is never read for
// one, so a query param can never name another student.

export type ExportRouteDeps = {
  sessionUserId?: () => Promise<string | null>;
  userExists?: (userId: string) => Promise<boolean>;
  build?: (userId: string, at: Date) => Promise<PrivacyExport>;
  rateLimit?: ExportRateLimiter;
  now?: () => Date;
};

// The export route builds these lazily, never at import time. The rate
// limiter is shared across requests: one instance per server process, so the
// per user window survives from one download to the next.
let sharedRateLimiter: ExportRateLimiter | undefined;

export function realExportRouteDeps(): ExportRouteDeps {
  sharedRateLimiter ??= createExportRateLimiter();
  const rateLimit = sharedRateLimiter;
  return {
    sessionUserId: async () => (await getSessionUser())?.userId ?? null,
    userExists: async (userId) => (await getUserById(userId)) != null,
    build: async (userId, at) =>
      buildExport(getSupabase(), userId, {
        storage: getSupabase().storage,
        bucket: env.SUPABASE_STORAGE_BUCKET,
        now: () => at,
      }),
    rateLimit,
  };
}

// The date stamp in the file name is Singapore wall clock, the product's
// clock everywhere else in the codebase (SGT is UTC+8 all year).
export function exportFileStamp(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function redirectToLogin(): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: "/login", "Cache-Control": "no-store" },
  });
}

export async function handleAccountExport(
  deps: ExportRouteDeps = {},
  args: { url?: string } = {},
): Promise<Response> {
  // args.url exists only so tests can prove a query param user id is never
  // used; the handler reads nothing from it.
  void args.url;

  const sessionUserId = deps.sessionUserId ?? (async () => null);
  const userId = await sessionUserId();
  if (userId == null) return redirectToLogin();

  const userExists = deps.userExists ?? (async () => true);
  if (!(await userExists(userId))) return redirectToLogin();

  const now = (deps.now ?? (() => new Date()))();
  const verdict = (deps.rateLimit ?? createExportRateLimiter())(userId, now);
  if (!verdict.ok) {
    return new Response(EXPORT_RATE_LIMIT_LINE, {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const build = deps.build;
  if (!build) throw new Error("handleAccountExport needs deps.build (or inject the real one).");
  const data = await build(userId, now);

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="settle-data-${exportFileStamp(now)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
