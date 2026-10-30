// Reads the raw env var directly (never lib/env) so the landing page can be
// prerendered with no environment at all.
export function botLink(): string | null {
  const raw = process.env.TELEGRAM_BOT_USERNAME;
  if (raw === undefined) return null;
  const handle = raw.trim().replace(/^@/, "");
  if (handle === "") return null;
  return `https://t.me/${handle}`;
}
