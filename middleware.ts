import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/auth/access";
import { publicOrigin } from "@/lib/auth/origin";
import { EXPIRED_PATH, REQUEST_PATH_HEADER } from "@/lib/auth/paths";
import { SESSION_COOKIE } from "@/lib/auth/jwt";

export const config = {
  matcher: ["/dashboard/:path*", "/tasks/:path*", "/weak-spots/:path*", "/billing/:path*", "/account/:path*"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Edge runtime: SESSION_SECRET and APP_BASE_URL come straight from
  // process.env because lib/env imports "server-only", which cannot load here.
  // Redirects must be built from the configured public origin, never from
  // request.url: behind Caddy the container sees http://0.0.0.0:3000.
  const origin = publicOrigin(process.env.APP_BASE_URL, request.url);
  const decision = await decideAccess(
    request.nextUrl.pathname,
    request.cookies.get(SESSION_COOKIE)?.value,
    process.env.SESSION_SECRET,
    new Date(),
  );
  if (decision === "allow") {
    // Pass the matched path downstream so requireSessionUser can redirect a
    // stale-acceptance user back to the page they asked for.
    const headers = new Headers(request.headers);
    headers.set(REQUEST_PATH_HEADER, request.nextUrl.pathname);
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.redirect(new URL(EXPIRED_PATH, origin), 307);
}
