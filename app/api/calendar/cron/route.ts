import { handleCalendarCron } from "@/lib/calendar/handlers";
import { realCalendarRouteDeps } from "@/lib/calendar/runtime";

export const runtime = "nodejs";

// Reconcile every active connection, guarded by the shared cron secret.
// Both methods are accepted so the scheduler needs no special setup.
export async function GET(req: Request): Promise<Response> {
  return handleCalendarCron(realCalendarRouteDeps(), req.headers.get("authorization"));
}

export async function POST(req: Request): Promise<Response> {
  return handleCalendarCron(realCalendarRouteDeps(), req.headers.get("authorization"));
}
