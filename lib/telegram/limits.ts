// Per-user rate limit for ingesting messages. State lives in the uploads
// table, not memory, because the bot runs serverless: each check counts the
// uploads the user created inside the sliding window. A failed lookup must
// never block a student's capture, so callers fail open (see handlers.ts).
import type { SupabaseClient } from "@supabase/supabase-js";

export const RATE_LIMIT = { windowSeconds: 60, max: 8 } as const;

export type RateLimitSettings = { windowSeconds: number; max: number };

export type RateLimitVerdict = { allowed: boolean; retryAfterSeconds: number };

export type RateLimitCheck = (
  userId: string,
) => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;

// Pure decision: the count alone decides, so tests can table-drive it. With
// only a count we cannot know when the oldest upload leaves the window, so
// the quoted wait is the whole window rounded up to whole seconds. Exactly
// max uploads in the window is already over the line.
export function checkRateLimit(
  recentCount: number,
  limits?: RateLimitSettings,
): RateLimitVerdict {
  const settings = limits ?? RATE_LIMIT;
  if (recentCount < settings.max) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.ceil(settings.windowSeconds) };
}

export type RateLimiterDeps = {
  countRecentUploads: (userId: string, since: Date) => Promise<number>;
  now?: () => Date;
};

export function createRateLimiter(deps: RateLimiterDeps): { check: RateLimitCheck } {
  return {
    async check(userId) {
      const now = (deps.now ?? (() => new Date()))();
      const since = new Date(now.getTime() - RATE_LIMIT.windowSeconds * 1000);
      const recentCount = await deps.countRecentUploads(userId, since);
      const verdict = checkRateLimit(recentCount);
      return verdict.allowed
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: verdict.retryAfterSeconds };
    },
  };
}

// Query builder for the uploads count, split out so tests can inject a fake
// client and the wrapper below stays a thin lazy shell.
export async function countRecentUploadsWith(
  client: SupabaseClient,
  userId: string,
  since: Date,
): Promise<number> {
  const { count, error } = await client
    .from("uploads")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since.toISOString());
  if (error) {
    const suffix = error.code ? ` [${error.code}]` : "";
    throw new Error(`db countRecentUploads failed${suffix}: ${error.message}`);
  }
  return count ?? 0;
}

// Real counter bound to the shared service-role client. The import is dynamic
// so importing this module (replies.ts reuses RATE_LIMIT for its copy) never
// touches env or the database.
export async function countRecentUploads(userId: string, since: Date): Promise<number> {
  const { getSupabase } = await import("@/lib/db/client");
  return countRecentUploadsWith(getSupabase(), userId, since);
}
