import { handleMagicLink } from "@/lib/auth/login-route";
import { publicOrigin } from "@/lib/auth/origin";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  // Behind a proxy request.url carries the container's internal host, so the
  // redirect target is built from the configured public origin instead.
  return handleMagicLink(token, { origin: publicOrigin(process.env.APP_BASE_URL, request.url) });
}
