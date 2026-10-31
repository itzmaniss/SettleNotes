// Resolving the person behind a data request. Only the Telegram id is
// accepted, on purpose: names and usernames are not unique, and a delete that
// picks the wrong person is worse than no delete at all.
import type { SupabaseClient } from "@supabase/supabase-js";

export type SubjectErrorCode = "invalid_id" | "not_found" | "ambiguous";

export class SubjectResolutionError extends Error {
  readonly code: SubjectErrorCode;

  constructor(code: SubjectErrorCode, message: string) {
    super(message);
    this.name = "SubjectResolutionError";
    this.code = code;
  }
}

export function isValidTelegramId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

// Short display form for operator output: enough to correlate two runs of the
// script, never enough to identify anyone by itself.
export function shortId(userId: string): string {
  return userId.slice(0, 8);
}

// Returns the users row id for exactly one match. Zero matches or more than
// one are typed errors the caller must handle.
export async function resolveSubject(
  client: SupabaseClient,
  subject: { telegramId: number },
): Promise<string> {
  if (!isValidTelegramId(subject.telegramId)) {
    throw new SubjectResolutionError("invalid_id", "A Telegram id must be a positive whole number.");
  }
  const { data, error } = await client
    .from("users")
    .select("id")
    .eq("telegram_user_id", subject.telegramId)
    .limit(2);
  if (error) throw new Error(`subject lookup failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) {
    throw new SubjectResolutionError("not_found", "No Settle account exists for this Telegram id.");
  }
  if (rows.length > 1) {
    throw new SubjectResolutionError(
      "ambiguous",
      "More than one account matches this Telegram id, which should be impossible (the column is unique). Resolve the duplicate rows by hand before running anything.",
    );
  }
  return rows[0]!.id;
}
