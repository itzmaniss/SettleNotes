import { describe, expect, test } from "bun:test";
import {
  formatSmokeResults,
  normalizeBaseUrl,
  runSmokeChecks,
  type SmokeResponse,
} from "../../scripts/smoke";

type FakeRoute = { status: number; headers?: Record<string, string>; body?: string };

// A fake server: a plain map from "METHOD url" to a response, plus the log of
// what was requested. No network anywhere.
function fakeServer(routes: Record<string, FakeRoute>) {
  const requests: Array<{ url: string; method: string }> = [];
  const fetcher = async (url: string, init?: { method?: string }): Promise<SmokeResponse> => {
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    const route = routes[`${method} ${url}`];
    if (route == null) {
      throw new Error(`connection refused for ${url}`);
    }
    return {
      status: route.status,
      headers: {
        get: (name: string) => {
          const lower = name.toLowerCase();
          const found = Object.entries(route.headers ?? {}).find(([k]) => k.toLowerCase() === lower);
          return found ? found[1] : null;
        },
      },
      body: route.body ?? "",
    };
  };
  return { fetcher, requests };
}

const BASE = "https://settle.example.com";
const GARBAGE_LOGIN = `${BASE}/auth/telegram?id=1&hash=deadbeef`;

// A deployment where everything is fine, legal pages included.
function healthyRoutes(): Record<string, FakeRoute> {
  return {
    [`GET ${BASE}/`]: { status: 200, body: "<html><title>Settle: your group chat, sorted</title></html>" },
    [`GET ${BASE}/api/health`]: { status: 200, body: '{"ok":true}' },
    [`GET ${BASE}/login`]: { status: 200, body: "<html>log in</html>" },
    [`GET ${BASE}/dashboard`]: { status: 307, headers: { location: `${BASE}/auth/expired` } },
    [`GET ${BASE}/billing`]: { status: 303, headers: { location: `${BASE}/auth/expired` } },
    [`GET ${BASE}/tasks`]: { status: 307, headers: { location: `${BASE}/auth/expired` } },
    [`GET ${BASE}/weak-spots`]: { status: 307, headers: { location: `${BASE}/auth/expired` } },
    [`GET ${BASE}/api/telegram`]: { status: 405, body: "" },
    [`POST ${BASE}/api/telegram`]: { status: 401, body: "" },
    [`POST ${BASE}/api/stripe/webhook`]: { status: 400, body: "" },
    [`GET ${GARBAGE_LOGIN}`]: { status: 303, headers: { location: `${BASE}/login?error=failed` } },
    [`GET ${BASE}/terms`]: { status: 200, body: "<html>terms</html>" },
    [`GET ${BASE}/privacy`]: { status: 200, body: "<html>privacy</html>" },
    [`GET ${BASE}/refund`]: { status: 200, body: "<html>refund</html>" },
  };
}

describe("runSmokeChecks", () => {
  test("a healthy https deployment passes everything with no x-powered-by", async () => {
    const { fetcher } = fakeServer(healthyRoutes());
    const results = await runSmokeChecks(fetcher, BASE);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  test("the two POST checks go to the right paths, and every URL stays inside the base", async () => {
    const { fetcher, requests } = fakeServer(healthyRoutes());
    await runSmokeChecks(fetcher, BASE);
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.url)).toEqual([`${BASE}/api/telegram`, `${BASE}/api/stripe/webhook`]);
    expect(requests.every((r) => r.url.startsWith(`${BASE}/`))).toBe(true);
  });

  test("missing legal pages warn instead of failing", async () => {
    const routes = healthyRoutes();
    for (const path of ["/terms", "/privacy", "/refund"]) {
      routes[`GET ${BASE}${path}`] = { status: 404, body: "not found" };
    }
    const { fetcher } = fakeServer(routes);
    const results = await runSmokeChecks(fetcher, BASE);
    const legal = results.filter((r) => r.name.startsWith("legal page"));
    expect(legal.map((r) => r.status)).toEqual(["warn", "warn", "warn"]);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
  });

  test("a protected path answering 200 without a session fails", async () => {
    const routes = healthyRoutes();
    routes[`GET ${BASE}/dashboard`] = { status: 200, body: "<html>your week</html>" };
    const { fetcher } = fakeServer(routes);
    const results = await runSmokeChecks(fetcher, BASE);
    const gate = results.find((r) => r.name === "session gate /dashboard");
    expect(gate?.status).toBe("fail");
    expect(gate?.detail).toContain("without a session");
  });

  test("a protected path redirected somewhere other than expired fails", async () => {
    const routes = healthyRoutes();
    routes[`GET ${BASE}/billing`] = { status: 307, headers: { location: `${BASE}/login` } };
    const { fetcher } = fakeServer(routes);
    const results = await runSmokeChecks(fetcher, BASE);
    const gate = results.find((r) => r.name === "session gate /billing");
    expect(gate?.status).toBe("fail");
  });

  test("a login failure that sets a cookie fails", async () => {
    const routes = healthyRoutes();
    routes[`GET ${GARBAGE_LOGIN}`] = {
      status: 303,
      headers: { location: `${BASE}/login?error=failed`, "set-cookie": "session=x" },
    };
    const { fetcher } = fakeServer(routes);
    const results = await runSmokeChecks(fetcher, BASE);
    const login = results.find((r) => r.name === "telegram login rejects garbage");
    expect(login?.status).toBe("fail");
    expect(login?.detail).toContain("set a cookie");
  });

  test("a stripe webhook that answers 200 to an unsigned POST fails", async () => {
    const routes = healthyRoutes();
    routes[`POST ${BASE}/api/stripe/webhook`] = { status: 200, body: "{}" };
    const { fetcher } = fakeServer(routes);
    const results = await runSmokeChecks(fetcher, BASE);
    const stripe = results.find((r) => r.name === "stripe webhook refuses unsigned calls");
    expect(stripe?.status).toBe("fail");
  });

  test("a landing page without Settle in the title fails", async () => {
    const routes = healthyRoutes();
    routes[`GET ${BASE}/`] = { status: 200, body: "<html><title>Something else</title></html>" };
    const { fetcher } = fakeServer(routes);
    const results = await runSmokeChecks(fetcher, BASE);
    const landing = results.find((r) => r.name === "landing page");
    expect(landing?.status).toBe("fail");
  });

  test("http bases skip the https only checks and pass when healthy", async () => {
    const local = "http://localhost:3000";
    const { fetcher } = fakeServer({
      [`GET ${local}/`]: { status: 200, body: "<title>Settle</title>" },
      [`GET ${local}/api/health`]: { status: 200, body: '{"ok":true}' },
      [`GET ${local}/login`]: { status: 200, body: "ok" },
      [`GET ${local}/dashboard`]: { status: 307, headers: { location: `${local}/auth/expired` } },
      [`GET ${local}/billing`]: { status: 307, headers: { location: `${local}/auth/expired` } },
      [`GET ${local}/tasks`]: { status: 307, headers: { location: `${local}/auth/expired` } },
      [`GET ${local}/weak-spots`]: { status: 307, headers: { location: `${local}/auth/expired` } },
      [`GET ${local}/api/telegram`]: { status: 405 },
      [`POST ${local}/api/telegram`]: { status: 401 },
      [`POST ${local}/api/stripe/webhook`]: { status: 503 },
      [`GET ${local}/auth/telegram?id=1&hash=deadbeef`]: {
        status: 303,
        headers: { location: `${local}/login?error=failed` },
      },
      [`GET ${local}/terms`]: { status: 404 },
      [`GET ${local}/privacy`]: { status: 404 },
      [`GET ${local}/refund`]: { status: 404 },
    });
    const results = await runSmokeChecks(fetcher, local);
    expect(results.find((r) => r.name === "no x-powered-by header")).toBeUndefined();
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
  });

  test("an unreachable base fails its checks instead of crashing", async () => {
    const { fetcher } = fakeServer({});
    const results = await runSmokeChecks(fetcher, BASE);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.status === "fail")).toBe(true);
    expect(results[0].detail).toContain("connection refused");
  });
});

describe("formatSmokeResults", () => {
  test("prints PASS/WARN/FAIL lines and a summary, and counts failures", () => {
    const { lines, failures } = formatSmokeResults([
      { name: "health endpoint", status: "pass", detail: "200" },
      { name: "legal page /terms", status: "warn", detail: "404" },
      { name: "session gate /dashboard", status: "fail", detail: "200 without a session" },
    ]);
    expect(lines[0]).toMatch(/^PASS  health endpoint: 200$/);
    expect(lines[1]).toMatch(/^WARN  legal page \/terms: 404$/);
    expect(lines[2]).toMatch(/^FAIL  session gate \/dashboard: 200 without a session$/);
    expect(lines[3]).toContain("Summary: 1 passed, 1 warned, 1 failed");
    expect(failures).toBe(1);
    expect(lines.join("\n")).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("normalizeBaseUrl", () => {
  test("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://x.example/")).toBe("https://x.example");
    expect(normalizeBaseUrl("https://x.example///")).toBe("https://x.example");
  });
});
