import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/auth/access";
import { SESSION_COOKIE } from "@/lib/auth/jwt";
import { EXPIRED_PATH } from "@/lib/auth/paths";

export const config = {
  matcher: ["/dashboard/:path*", "/tasks/:path*", "/weak-spots/:path*"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Edge runtime: SESSION_SECRET comes straight from process.env because
  // lib/env and server-only modules cannot be imported here.
  const decision = await decideAccess(
    request.nextUrl.pathname,
    request.cookies.get(SESSION_COOKIE)?.value,
    process.env.SESSION_SECRET,
    new Date(),
  );
  if (decision === "allow") return NextResponse.next();
  return NextResponse.redirect(new URL(EXPIRED_PATH, request.url), 307);
}
