import "server-only";
import { env } from "@/lib/env";
import { createSessionToken, serializeSessionCookie } from "./session";
import { EXPIRED_PATH, POST_LOGIN_PATH } from "./paths";
import { redeemLoginToken } from "./tokens";

// The logic behind app/auth/[token]/route.ts, kept here so tests can inject
// fakes; the route file itself stays a thin wrapper.
export type MagicLinkDeps = {
  redeem?: (raw: string) => Promise<{ userId: string } | null>;
  createSession?: (userId: string) => Promise<string>;
  origin?: string;
};

function redirect(location: string, cookie?: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      // The single use token must never be cached, logged as a referrer, or
      // set as a cookie on the failure path.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
}

function absolute(path: string, origin: string | undefined): string {
  if (!origin) return path;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}

export async function handleMagicLink(rawToken: string, deps: MagicLinkDeps = {}): Promise<Response> {
  const redeem = deps.redeem ?? ((raw: string) => redeemLoginToken(raw));
  const createSession = deps.createSession ?? ((userId: string) => createSessionToken(userId));
  const origin = deps.origin ?? env.APP_BASE_URL;

  const result = await redeem(rawToken);
  if (!result) return redirect(absolute(EXPIRED_PATH, origin));

  const token = await createSession(result.userId);
  return redirect(absolute(POST_LOGIN_PATH, origin), serializeSessionCookie(token, origin));
}
