// Clearing the session cookie for log out and for a completed account
// deletion. Same name, path and attributes as when the cookie was set
// (lib/auth/jwt.ts), but Max-Age 0 so the browser drops it. The store is
// injected so tests can capture the attributes without next/headers.
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/jwt";

export type CookieStoreLike = {
  set(options: {
    name: string;
    value: string;
    path: string;
    httpOnly: boolean;
    sameSite: "lax";
    secure: boolean;
    maxAge: number;
  }): unknown;
};

export function clearSessionCookie(store: CookieStoreLike, appBaseUrl: string): void {
  const { secure } = sessionCookieOptions(appBaseUrl);
  store.set({
    name: SESSION_COOKIE,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 0,
  });
}
