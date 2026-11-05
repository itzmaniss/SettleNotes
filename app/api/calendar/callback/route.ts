import { handleCalendarCallback } from "@/lib/calendar/handlers";
import { realCalendarRouteDeps } from "@/lib/calendar/runtime";

export const runtime = "nodejs";

// Step two of the Pro calendar connect: verifies the state cookie, swaps
// the code for tokens, stores the encrypted refresh token and runs one sync.
export async function GET(req: Request): Promise<Response> {
  return handleCalendarCallback(realCalendarRouteDeps(), req.url, req.headers.get("cookie"));
}
