import { handleCalendarDisconnect } from "@/lib/calendar/handlers";
import { realCalendarRouteDeps } from "@/lib/calendar/runtime";

export const runtime = "nodejs";

// The Account page posts here: removes the Settle Google calendar, revokes
// the grant, and deletes the stored rows, best effort on the Google side.
export async function POST(): Promise<Response> {
  return handleCalendarDisconnect(realCalendarRouteDeps());
}
