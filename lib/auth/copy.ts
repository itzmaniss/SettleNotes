// Student facing copy for dashboard auth: the /dashboard bot reply and the
// expired link page. Plain, warm, and free of em or en dashes.

export function dashboardLinkReply(link: string): string {
  return [
    "Here is your dashboard link. It works once and expires in 15 minutes.",
    "",
    link,
  ].join("\n");
}

export function dashboardLinkFailureReply(): string {
  return "Sorry, I couldn't make a link just now. Please try /dashboard again in a minute.";
}

export const EXPIRED_PAGE_TITLE = "That link has expired.";

export const EXPIRED_PAGE_BODY =
  "Dashboard links are single use and they stop working after 15 minutes, so this one cannot be opened again.";

export const EXPIRED_PAGE_HINT =
  "Open Telegram, send /dashboard to your Settle bot, and it will send you a fresh link right away.";
