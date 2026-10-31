// Per-user rate limits for ingesting messages. State lives in the uploads
// table, not memory, because the bot runs serverless: each check counts the
// uploads the user created inside the sliding window. A failed lookup must
// never block a student's capture, so callers fail open (see handlers.ts).
import type { SupabaseClient } from "@supabase/supabase-js";

export const RATE_LIMIT = { windowSeconds: 60, max: 8 } as const;

// Hard pause for one calendar day's worth of sliding window. Same table, so
// the limiter is two count queries and nothing else.
export const DAILY_UPLOAD_CAP = { windowSeconds: 86400, max: 150 } as const;

export type RateLimitSettings = { windowSeconds: number; max: number };

export type RateLimitVerdict = { allowed: boolean; retryAfterSeconds: number };

export type RateLimitWindow = "minute" | "day";

// window is always set by createRateLimiter; it stays optional so tiny test
// fakes stay valid, and callers treat a missing window as the minute limit.
export type RateLimitOutcome =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; window?: RateLimitWindow };

export type RateLimitCheck = (
  userId: string,
) => RateLimitOutcome | Promise<RateLimitOutcome>;

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

// Same pure shape as checkRateLimit, for the daily cap. Kept separate so the
// minute limit and the day cap can move independently.
export function checkDailyCap(count: number, cap?: RateLimitSettings): RateLimitVerdict {
  const settings = cap ?? DAILY_UPLOAD_CAP;
  if (count < settings.max) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.ceil(settings.windowSeconds) };
}

export type RateLimiterDeps = {
  countRecentUploads: (userId: string, since: Date) => Promise<number>;
  now?: () => Date;
};

export function createRateLimiter(deps: RateLimiterDeps): { check: RateLimitCheck } {
  return {
    async check(userId): Promise<RateLimitOutcome> {
      const now = (deps.now ?? (() => new Date()))();
      // The minute window is checked first, so a student hammering the bot
      // gets the short retry line, not the pause-for-today one.
      const minuteCount = await deps.countRecentUploads(
        userId,
        new Date(now.getTime() - RATE_LIMIT.windowSeconds * 1000),
      );
      const minuteVerdict = checkRateLimit(minuteCount);
      if (!minuteVerdict.allowed) {
        return {
          allowed: false,
          retryAfterSeconds: minuteVerdict.retryAfterSeconds,
          window: "minute",
        };
      }
      const dayCount = await deps.countRecentUploads(
        userId,
        new Date(now.getTime() - DAILY_UPLOAD_CAP.windowSeconds * 1000),
      );
      const dayVerdict = checkDailyCap(dayCount);
      if (!dayVerdict.allowed) {
        return {
          allowed: false,
          retryAfterSeconds: dayVerdict.retryAfterSeconds,
          window: "day",
        };
      }
      return { allowed: true };
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
