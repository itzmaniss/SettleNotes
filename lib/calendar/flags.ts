// Feature switch for Google Calendar sync. Pure over a process.env style
// input so routes, the Account page and tests share one definition.
export function isCalendarSyncEnabled(
  envInput: Record<string, string | undefined> = process.env,
): boolean {
  const present = (value: string | undefined): boolean =>
    typeof value === "string" && value.trim().length > 0;
  return (
    envInput.CALENDAR_SYNC_ENABLED === "true" &&
    present(envInput.GOOGLE_CLIENT_ID) &&
    present(envInput.GOOGLE_CLIENT_SECRET) &&
    present(envInput.CALENDAR_TOKEN_KEY) &&
    present(envInput.CALENDAR_CRON_SECRET)
  );
}
