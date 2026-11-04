import { handleAccountExport, realExportRouteDeps } from "@/lib/account/export-route";

// GET /account/export: the student's own data as a JSON attachment. The user
// id comes only from the signed session, never from the URL. Middleware
// guards the path for signed-out visitors; the handler itself also fails
// closed and redirects to /login without a session or a missing user row.
export async function GET(request: Request): Promise<Response> {
  return handleAccountExport(realExportRouteDeps(), { url: request.url });
}
