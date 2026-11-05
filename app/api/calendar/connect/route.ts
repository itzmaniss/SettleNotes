import { handleCalendarConnect } from "@/lib/calendar/handlers";
import { realCalendarRouteDeps } from "@/lib/calendar/runtime";

export const runtime = "nodejs";

// Step one of the Pro calendar connect: session, plan, then off to Google
// with a signed state cookie. All logic lives in the handler for tests.
export async function GET(req: Request): Promise<Response> {
  return handleCalendarConnect(realCalendarRouteDeps(), req.url);
}
