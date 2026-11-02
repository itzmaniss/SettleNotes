// Post deploy smoke test: point it at a base URL and get a PASS/FAIL/WARN
// checklist. Fails (exit 1) when any check fails, so it can gate a launch.
// Usage: bun run scripts/smoke.ts [base url]     (default http://localhost:3000)
//
// SAFETY: every request, including the POST checks, goes to the one base URL
// given on the command line and nowhere else; the pure check builder refuses
// any URL outside it. No secrets are ever sent: the webhook POST deliberately
// omits the secret header and the Stripe POST omits the signature.

export type SmokeStatus = "pass" | "fail" | "warn";

export type SmokeResult = {
  name: string;
  status: SmokeStatus;
  detail: string;
};

// Minimal response shape the checks need, so tests can fake a whole server
// with a plain map and no network.
export type SmokeResponse = {
  status: number;
  headers: { get: (name: string) => string | null };
  body: string;
};

export type SmokeFetcher = (url: string, init?: { method?: string }) => Promise<SmokeResponse>;

export const DEFAULT_BASE_URL = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 10_000;

export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

// Every request URL is derived from the base and verified to stay inside it.
function urlFor(base: string, path: string): string {
  const url = `${base}${path}`;
  if (!url.startsWith(`${base}/`)) {
    throw new Error(`check URL ${url} is outside the given base ${base}, refusing to send`);
  }
  return url;
}

async function request(fetcher: SmokeFetcher, base: string, path: string, method = "GET"): Promise<SmokeResponse> {
  return fetcher(urlFor(base, path), method === "GET" ? undefined : { method });
}

const PROTECTED_PATHS = ["/dashboard", "/billing", "/tasks", "/weak-spots"] as const;
const LEGAL_PATHS = ["/terms", "/privacy", "/refund"] as const;

// Detail suffix for a 500: behind the proxy a missing env var looks like a
// broken route, so the message points at configuration first.
const CONFIG_HINT = "is the server configured?";

function detailFor(res: SmokeResponse, detail: string): string {
  return res.status === 500 ? `${detail}; ${CONFIG_HINT}` : detail;
}

// A redirect Location is safe when it is a relative path or shares the base
// URL's origin. Anything else means a redirect was built from request.url or
// the Host header behind the proxy, which sends people to a dead address.
function redirectStaysOnBaseOrigin(location: string, base: string): boolean {
  if (location.startsWith("/")) return true;
  try {
    return new URL(location).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

// Runs every check against the fake or real fetcher. Never throws: a network
// style error becomes a FAIL for that check.
export async function runSmokeChecks(fetcher: SmokeFetcher, rawBase: string): Promise<SmokeResult[]> {
  const base = normalizeBaseUrl(rawBase);
  const results: SmokeResult[] = [];
  // Every redirect Location seen in the checks above, for the origin check.
  const redirectLocations: string[] = [];

  async function check(name: string, run: () => Promise<SmokeResult>): Promise<void> {
    try {
      results.push(await run());
    } catch (error) {
      results.push({
        name,
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fetched once, then reused by the https checks below, so an unreachable
  // base fails checks individually instead of crashing the run.
  let landing: SmokeResponse | null = null;
  const landingPage = async (): Promise<SmokeResponse> => {
    if (landing == null) landing = await request(fetcher, base, "/");
    return landing;
  };

  await check("health endpoint", async () => {
    const res = await request(fetcher, base, "/api/health");
    const ok = res.status === 200 && res.body.includes('"ok"') && res.body.includes("true");
    return {
      name: "health endpoint",
      status: ok ? "pass" : "fail",
      detail: detailFor(res, `GET /api/health returned ${res.status}`),
    };
  });

  await check("landing page", async () => {
    const res = await landingPage();
    const mentionsSettle = /<title[^>]*>[^<]*settle/i.test(res.body);
    return {
      name: "landing page",
      status: res.status === 200 && mentionsSettle ? "pass" : "fail",
      detail: detailFor(
        res,
        `GET / returned ${res.status}${mentionsSettle ? "" : " and the title does not mention Settle"}`,
      ),
    };
  });

  await check("login page", async () => {
    const res = await request(fetcher, base, "/login");
    return {
      name: "login page",
      status: res.status === 200 ? "pass" : "fail",
      detail: detailFor(res, `GET /login returned ${res.status}`),
    };
  });

  for (const path of PROTECTED_PATHS) {
    await check(`session gate ${path}`, async () => {
      const res = await request(fetcher, base, path);
      const location = res.headers.get("location") ?? "";
      if (location) redirectLocations.push(location);
      const redirectedAway = (res.status === 307 || res.status === 303) && location.includes("/auth/expired");
      return {
        name: `session gate ${path}`,
        status: redirectedAway ? "pass" : "fail",
        detail: detailFor(
          res,
          res.status === 200
            ? `GET ${path} answered 200 without a session, the gate is missing`
            : `GET ${path} returned ${res.status} to ${location || "no location"}`,
        ),
      };
    });
  }

  await check("telegram route exists", async () => {
    const res = await request(fetcher, base, "/api/telegram");
    return {
      name: "telegram route exists",
      status: res.status === 405 ? "pass" : "fail",
      detail: detailFor(
        res,
        `GET /api/telegram returned ${res.status} (405 expected for the wrong verb)`,
      ),
    };
  });

  await check("telegram webhook refuses unsigned calls", async () => {
    const res = await request(fetcher, base, "/api/telegram", "POST");
    return {
      name: "telegram webhook refuses unsigned calls",
      status: res.status === 401 ? "pass" : "fail",
      detail: detailFor(
        res,
        `POST /api/telegram without the secret header returned ${res.status} (401 expected)`,
      ),
    };
  });

  await check("stripe webhook refuses unsigned calls", async () => {
    const res = await request(fetcher, base, "/api/stripe/webhook", "POST");
    const ok = res.status === 400 || res.status === 503;
    return {
      name: "stripe webhook refuses unsigned calls",
      status: ok ? "pass" : "fail",
      detail: detailFor(
        res,
        `POST /api/stripe/webhook without a signature returned ${res.status} (400 or 503 expected, never 200)`,
      ),
    };
  });

  await check("telegram login rejects garbage", async () => {
    const res = await request(fetcher, base, "/auth/telegram?id=1&hash=deadbeef");
    const location = res.headers.get("location") ?? "";
    if (location) redirectLocations.push(location);
    const redirected = res.status === 303 && location.includes("/login?error=failed");
    const setCookie = res.headers.get("set-cookie");
    return {
      name: "telegram login rejects garbage",
      status: redirected && setCookie == null ? "pass" : "fail",
      detail: detailFor(
        res,
        `GET /auth/telegram with garbage returned ${res.status} to ${location || "no location"}${
          setCookie == null ? "" : " and it set a cookie, which it must not"
        }`,
      ),
    };
  });

  for (const path of LEGAL_PATHS) {
    await check(`legal page ${path}`, async () => {
      const res = await request(fetcher, base, path);
      if (res.status !== 200) {
        // The pages ship with the app, so a missing page is a broken
        // deployment, not a reminder.
        return {
          name: `legal page ${path}`,
          status: "fail",
          detail: detailFor(res, `GET ${path} returned ${res.status}`),
        };
      }
      // A [[ in the body means a counsel marker or a missing variable reached
      // the reader. Over https that fails the launch; locally (http) the env
      // is often not filled yet, so it only warns.
      if (res.body.includes("[[")) {
        return {
          name: `legal page ${path}`,
          status: base.startsWith("https://") ? "fail" : "warn",
          detail: `GET ${path} returned 200 but the body still carries an unresolved [[...]] marker or token`,
        };
      }
      return {
        name: `legal page ${path}`,
        status: "pass",
        detail: `GET ${path} returned 200 with no unresolved markers`,
      };
    });
  }

  await check("redirects stay on the public origin", async () => {
    if (redirectLocations.length === 0) {
      return {
        name: "redirects stay on the public origin",
        status: "warn",
        detail: "no redirect was observed, so there was nothing to check",
      };
    }
    const offenders = redirectLocations.filter(
      (location) => !redirectStaysOnBaseOrigin(location, base),
    );
    if (offenders.length === 0) {
      return {
        name: "redirects stay on the public origin",
        status: "pass",
        detail: `all ${redirectLocations.length} redirect locations are relative or share the base origin`,
      };
    }
    return {
      name: "redirects stay on the public origin",
      status: "fail",
      detail: `redirects leave the base origin (${base}): ${offenders.join(", ")}`,
    };
  });

  if (base.startsWith("https://")) {
    await check("https landing is redirect free", async () => {
      const res = await landingPage();
      const ok = res.status === 200;
      return {
        name: "https landing is redirect free",
        status: ok ? "pass" : "fail",
        detail: ok ? "GET / landed on 200 over https with no redirect" : `GET / returned ${res.status}`,
      };
    });
    await check("no x-powered-by header", async () => {
      const res = await landingPage();
      const header = res.headers.get("x-powered-by");
      return {
        name: "no x-powered-by header",
        status: header == null ? "pass" : "fail",
        detail: header == null ? "the landing response carries no x-powered-by header" : `x-powered-by: ${header}`,
      };
    });
  }

  return results;
}

export function formatSmokeResults(results: SmokeResult[]): { lines: string[]; failures: number } {
  const lines = results.map((result) => {
    const label = result.status === "pass" ? "PASS" : result.status === "warn" ? "WARN" : "FAIL";
    return `${label}  ${result.name}: ${result.detail}`;
  });
  const failures = results.filter((result) => result.status === "fail").length;
  const warns = results.filter((result) => result.status === "warn").length;
  lines.push(
    `Summary: ${results.length - failures - warns} passed, ${warns} warned, ${failures} failed against the given base URL.`,
  );
  return { lines, failures };
}

// ---- the only I/O in the file -----------------------------------------------

function realFetcher(): SmokeFetcher {
  return async (url, init) => {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(init?.method != null ? { method: init.method } : {}),
      ...(init?.method != null && init.method !== "GET"
        ? { headers: { "content-type": "application/json" }, body: "{}" }
        : {}),
    });
    return {
      status: res.status,
      headers: { get: (name) => res.headers.get(name) },
      body: await res.text(),
    };
  };
}

async function main(): Promise<number> {
  const raw = process.argv[2];
  const base = normalizeBaseUrl(raw ?? DEFAULT_BASE_URL);
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    console.error(`Give an http(s) base URL, got ${base}`);
    return 1;
  }
  console.log(`Smoke testing ${base}`);
  const results = await runSmokeChecks(realFetcher(), base);
  const { lines, failures } = formatSmokeResults(results);
  for (const line of lines) console.log(line);
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
