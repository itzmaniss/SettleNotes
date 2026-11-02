import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./fake-supabase";
import {
  BASE_OBJECTS,
  NAME_A,
  NAME_B,
  TASK_B1,
  UPLOAD_A1,
  USER_A,
  USER_B,
  baseTables,
} from "./fixtures";
import { buildExport } from "../../lib/privacy/export";

const NOW = () => new Date("2026-11-01T08:09:10.000Z");

describe("buildExport", () => {
  test("contains every section, the file list, a note and a timestamp", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const data = await buildExport(fake.client, USER_A, { bucket: "uploads", now: NOW });
    expect(Object.keys(data).sort()).toEqual(
      [
        "account",
        "ai_calls_summary",
        "exported_at",
        "files",
        "note",
        "pending_actions",
        "purchase_confirmations",
        "starters",
        "subscriptions",
        "task_events",
        "tasks",
        "uploads",
        "usage_events",
        "weak_spots",
      ].sort(),
    );
    expect(data.exported_at).toBe("2026-11-01T08:09:10.000Z");
    expect(data.note).toMatch(/Included:/);
    expect(data.note).toMatch(/Not included: login tokens/);
    expect(data.files).toEqual(BASE_OBJECTS.filter((p) => p.startsWith(`${USER_A}/`)).sort());
    expect(data.account.id).toBe(USER_A);
    expect(data.uploads.length).toBe(2);
    expect(data.tasks.length).toBe(2);
    expect(data.task_events.length).toBe(2);
    expect(data.starters.length).toBe(1);
    expect(data.weak_spots.length).toBe(1);
    expect(data.subscriptions).toEqual([
      {
        provider: "stripe",
        provider_ref: "sub_secret_ref_1",
        plan: "pro",
        status: "active",
        current_period_end: expect.any(String),
        created_at: expect.any(String),
      },
    ]);
    expect(data.pending_actions[0]).toMatchObject({ kind: "create", payload: { title: "A pending action" } });
    expect(data.starters[0]!.content).toEqual({ items: [{ text: "A checklist item" }] });
  });

  test("the ai calls section is a summary only: no per call rows, correct totals", async () => {
    const fake = makeFakeDb(baseTables());
    const data = await buildExport(fake.client, USER_A, { now: NOW });
    expect(JSON.stringify(data)).not.toContain("latency_ms");
    expect(data.ai_calls_summary).toEqual({
      count: 2,
      total_input_tokens: 300,
      total_output_tokens: 130,
      total_cost_usd: 0.002,
      by_purpose: {
        understand: { count: 1, total_input_tokens: 100, total_output_tokens: 50, total_cost_usd: 0.0015 },
        math: { count: 1, total_input_tokens: 200, total_output_tokens: 80, total_cost_usd: 0.0005 },
      },
    });
  });

  test("contains only the subject's data: no other user's id, name or content anywhere", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const data = await buildExport(fake.client, USER_A, { bucket: "uploads", now: NOW });
    const json = JSON.stringify(data);
    expect(json).not.toContain(USER_B);
    expect(json).not.toContain(NAME_B);
    expect(json).not.toContain(TASK_B1);
    expect(json).not.toContain("B private task title");
    expect(json).not.toContain("B card");
    expect(json).not.toContain("tokenhash-secret-B");
    expect(json).toContain(USER_A);
    expect(json).toContain(NAME_A);
    // Upload text belongs to the subject and is included.
    expect(data.uploads.some((u) => u.text_content === "Assignment brief text")).toBe(true);
  });

  test("login tokens are excluded entirely: never queried, never exported", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const data = await buildExport(fake.client, USER_A, { bucket: "uploads", now: NOW });
    const json = JSON.stringify(data);
    expect(json).not.toContain("login_tokens");
    expect(json).not.toContain("tokenhash");
    const selects = fake.ops.filter((op) => op.kind === "select");
    expect(selects.some((op) => op.kind === "select" && op.table === "login_tokens")).toBe(false);
  });

  test("every database query carries the user filter", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    await buildExport(fake.client, USER_A, { bucket: "uploads", now: NOW });
    const selects = fake.ops.filter((op): op is Extract<(typeof fake.ops)[number], { kind: "select" }> => op.kind === "select");
    expect(selects.length).toBe(11);
    for (const op of selects) {
      const hit = op.filters.some(
        (f) =>
          (f.column === "user_id" || f.column === "tasks.user_id" || f.column === "id") &&
          f.value === USER_A,
      );
      expect(hit).toBe(true);
    }
  });

  test("the export path is read only: no database writes and no storage removes", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    await buildExport(fake.client, USER_A, { bucket: "uploads", now: NOW });
    const mutating = fake.ops.filter(
      (op) =>
        op.kind === "update" || op.kind === "delete" || op.kind === "insert" || op.kind === "storage.remove",
    );
    expect(mutating).toEqual([]);
  });

  test("signed URLs never appear: only metadata and stored paths", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const data = await buildExport(fake.client, USER_A, { bucket: "uploads", now: NOW });
    expect(JSON.stringify(data)).not.toContain("signedUrl");
    expect(JSON.stringify(data)).not.toContain("https://");
    expect(data.uploads[0]!.storage_path).toContain(UPLOAD_A1);
  });

  test("telegram file ids are not part of the export", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const data = await buildExport(fake.client, USER_A, { bucket: "uploads", now: NOW });
    expect(JSON.stringify(data)).not.toContain("tgfile-secret");
  });
});
