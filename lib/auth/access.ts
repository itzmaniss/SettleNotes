// Access decision for the dashboard middleware. Edge safe: no server-only,
// no env imports; the caller injects the cookie value and secret.
import { verifySessionJwt } from "./jwt";
import { isProtectedPath } from "./paths";

export const MIN_SESSION_SECRET_LENGTH = 16;

export async function decideAccess(
  pathname: string,
  cookieValue: string | undefined | null,
  secret: string | undefined,
  now: Date,
): Promise<"allow" | "redirect"> {
  if (!isProtectedPath(pathname)) return "allow";
  // Fail closed: a missing or too short secret must never open the dashboard.
  if (typeof secret !== "string" || secret.length < MIN_SESSION_SECRET_LENGTH) {
    return "redirect";
  }
  const user = await verifySessionJwt(cookieValue, secret, now);
  return user ? "allow" : "redirect";
}
