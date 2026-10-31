// Route shapes the dashboard auth lives on. Pure constants and matching, so
// middleware, node code and tests all share one definition.

export const PROTECTED_PREFIXES = ["/dashboard", "/tasks", "/weak-spots", "/billing"];
export const POST_LOGIN_PATH = "/dashboard";
export const EXPIRED_PATH = "/auth/expired";

// Prefix match on segment boundary only, so "/dashboards" is not protected
// while "/dashboard/tasks/12" is.
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
