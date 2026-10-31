import { handleTelegramLogin, realTelegramLoginDeps } from "@/lib/auth/telegram-login";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleTelegramLogin(request, realTelegramLoginDeps());
}
