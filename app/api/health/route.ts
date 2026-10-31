// Liveness probe for the container HEALTHCHECK, compose status checks and
// uptime monitors. It reads no env, touches no database and calls no service,
// so it can answer even when configuration is broken. Middleware does not
// guard it: its matcher only covers /dashboard, /tasks and /weak-spots.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
