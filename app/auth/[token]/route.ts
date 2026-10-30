import { handleMagicLink } from "@/lib/auth/login-route";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  return handleMagicLink(token, { origin: new URL(request.url).origin });
}
