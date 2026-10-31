import { describe, expect, test } from "bun:test";
import { GET } from "../../app/api/health/route";

describe("GET /api/health", () => {
  test("returns 200 with ok true and no-store", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });
});
