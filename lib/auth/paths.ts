// Route shapes the dashboard auth lives on. Pure constants and matching, so
// middleware, node code and tests all share one definition.

export const PROTECTED_PREFIXES = ["/dashboard", "/tasks", "/weak-spots", "/billing"];
export const POST_LOGIN_PATH = "/dashboard";
export const EXPIRED_PATH = "/auth/expired";

// The acceptance page is public on purpose: it must never sit behind the
// session middleware matcher, or a person without a session could not reach it.
export const ACCEPT_PATH = "/accept";

// Prefix match on segment boundary only, so "/dashboards" is not protected
// while "/dashboard/tasks/12" is.
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

// Where a signed-in visitor may be sent after accepting. The same list as the
// protected prefixes: these are the pages a login or an acceptance is for.
export const LOGIN_NEXT_PREFIXES = PROTECTED_PREFIXES;

// The only open redirect surface shared by the Telegram login route, the
// /accept page and the acceptance gate: a next param survives if it is a
// same-site relative path (single leading slash), has no backslash, dot-dot
// or encoded dot-dot, and sits under an allowed prefix. Everything else,
// including //evil.com, https://evil.com and /\evil, falls back to /dashboard.
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
    return POST_LOGIN_PATH;
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return POST_LOGIN_PATH;
  }
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return POST_LOGIN_PATH;
  }
  if (path.includes("\\") || /[\r\n]/.test(path) || path.split("/").includes("..")) {
    return POST_LOGIN_PATH;
  }
  const allowed = LOGIN_NEXT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return allowed ? path : POST_LOGIN_PATH;
}

// Where to send a signed-in person whose acceptance is missing or stale.
// Without a known next path the bare /accept keeps the URL clean; the accept
// action then falls back to the dashboard.
export function acceptRedirectPath(next?: string | null): string {
  if (typeof next !== "string" || next.length === 0) return ACCEPT_PATH;
  return `${ACCEPT_PATH}?next=${encodeURIComponent(safeNextPath(next))}`;
}

// The middleware stamps the matched pathname onto this request header so
// server code (requireSessionUser) can build an /accept redirect back to the
// page the visitor wanted. Middleware overwrites whatever the client sent.
export const REQUEST_PATH_HEADER = "x-settle-path";
