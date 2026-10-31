// Tests for the demo seed's pure half: data shape, schema validity, key
// wiring, bucket spread, argument parser and the dry run printer. No db, no
// network, no env. scripts/seed-demo.ts (the I/O half) stays unexercised here.

import { describe, expect, test } from "bun:test";

import {
  DEMO_UPLOAD_MARKER,
  buildDemoData,
  demoTerms,
  formatDryRunPlan,
  parseSeedArgs,
  type DemoData,
  type DemoTask,
} from "../../scripts/seed-demo-data";
import { bucketOf, groupByBucket } from "@/lib/pipeline/priority";
import { parseStarterContent } from "@/lib/starters/types";

// A Wednesday in Singapore, mid afternoon. Fixed so every relative date in
// the demo data lands on a known bucket.
const NOW = new Date("2026-11-04T14:30:00+08:00");

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function sgtDayIndex(iso: string): number {
  return Math.floor((Date.parse(iso) + SGT_OFFSET_MS) / DAY_MS);
}

// The dashboard reads rows, so mirror its field names for the pure helpers.
function asRow(task: DemoTask) {
  return { ...task, due_at: task.dueAt, created_at: task.createdAt };
}

function keysOf(tasks: DemoTask[]): string[] {
  return tasks.map((task) => task.key).sort();
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (typeof value === "object" && value != null) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

describe("buildDemoData", () => {
  const data = buildDemoData(NOW);

  test("is deterministic for a fixed now", () => {
    const again = buildDemoData(NOW);
    expect(JSON.stringify(again)).toBe(JSON.stringify(data));
  });

  test("every starter validates against its real zod schema", () => {
    expect(data.starters.length).toBe(4);
    for (const entry of data.starters) {
      const parsed = parseStarterContent(entry.starter.type, entry.starter.content);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(`starter for ${entry.taskKey}: ${parsed.error}`);
    }
  });

  test("every key reference resolves", () => {
    const taskKeys = new Set(data.tasks.map((task) => task.key));
    const uploadKeys = new Set(data.uploads.map((upload) => upload.key));
    const weakSpotKeys = new Set(data.weakSpots.map((spot) => spot.key));

    for (const task of data.tasks) {
      if (task.uploadKey != null) expect(uploadKeys.has(task.uploadKey)).toBe(true);
      if (task.weakSpotKey != null) expect(weakSpotKeys.has(task.weakSpotKey)).toBe(true);
    }
    for (const event of data.taskEvents) {
      expect(taskKeys.has(event.taskKey)).toBe(true);
      if (event.uploadKey != null) expect(uploadKeys.has(event.uploadKey)).toBe(true);
    }
    for (const starter of data.starters) {
      expect(taskKeys.has(starter.taskKey)).toBe(true);
    }
  });

  test("bucket spread matches the dashboard groups", () => {
    const open = data.tasks.filter((task) => task.status === "open").map(asRow);
    const buckets = groupByBucket(open, NOW);

    expect(keysOf(buckets.overdue as unknown as DemoTask[])).toEqual(["ma2001_ps6"]);
    expect(keysOf(buckets.today as unknown as DemoTask[])).toEqual(["ee2026_prelab"]);
    expect(keysOf(buckets.this_week as unknown as DemoTask[])).toEqual([
      "ee2026_midterm",
      "review_chain_rule",
      "st2334_report",
    ]);
    expect(keysOf(buckets.later as unknown as DemoTask[])).toEqual([
      "cs2040_lab4",
      "ma2001_ps7",
      "ma2001_slides",
      "math_chain_rule",
    ]);

    // The reference dashboard: one overdue, one due today, a test in the week,
    // some later, one done, one with no deadline.
    expect(bucketOf(asRow(data.tasks.find((t) => t.key === "ee2026_prelab")!), NOW)).toBe("today");
    expect(bucketOf(asRow(data.tasks.find((t) => t.key === "ma2001_ps6")!), NOW)).toBe("overdue");
    expect(open.some((task) => task.kind === "test" && bucketOf(task, NOW) === "this_week")).toBe(true);
    const done = data.tasks.find((task) => task.status === "done");
    expect(done?.key).toBe("cs2040_tut7");
    expect(data.tasks.some((task) => task.dueAt === null && task.status === "open")).toBe(true);
  });

  test("the moved task carries created and updated events with the exact evidence", () => {
    const events = data.taskEvents.filter((event) => event.taskKey === "cs2040_lab4");
    const created = events.find((event) => event.action === "created");
    const updated = events.find((event) => event.action === "updated");
    expect(created).toBeDefined();
    expect(updated).toBeDefined();

    expect(updated?.evidence).toBe("prof say extend to nxt fri liao");
    const beforeDue = (updated?.before?.dueAt ?? null) as string | null;
    const afterDue = (updated?.after?.dueAt ?? null) as string | null;
    expect(beforeDue).not.toBeNull();
    expect(afterDue).not.toBeNull();
    expect(Date.parse(afterDue!)).toBeGreaterThan(Date.parse(beforeDue!));

    // The task's stored deadline is the post-move one.
    const task = data.tasks.find((t) => t.key === "cs2040_lab4")!;
    expect(task.dueAt).toBe(afterDue);
  });

  test("exactly one math diagnosis with a real first error and boxes on the grid", () => {
    const diagnoses = data.starters.filter((s) => s.starter.type === "math_diagnosis");
    expect(diagnoses.length).toBe(1);
    const diagnosis = diagnoses[0]!.starter.content as Extract<
      DemoData["starters"][number]["starter"],
      { type: "math_diagnosis" }
    >["content"];

    expect(diagnosis.is_correct).toBe(false);
    expect(diagnosis.first_error_step).toBe(3);
    expect(diagnosis.steps.map((step) => step.index)).toEqual([1, 2, 3, 4]);
    expect(diagnosis.steps.some((step) => step.index === diagnosis.first_error_step)).toBe(true);

    for (const step of diagnosis.steps) {
      expect(step.bbox).not.toBeNull();
      const box = step.bbox!;
      for (const value of [box.x1, box.y1, box.x2, box.y2]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1000);
      }
      expect(box.x1).toBeLessThan(box.x2);
      expect(box.y1).toBeLessThan(box.y2);
    }
  });

  test("weak spot counts are 3/2/1 with a review task for chain rule due tomorrow", () => {
    const byTopic = new Map(data.weakSpots.map((spot) => [spot.topic, spot]));
    expect(byTopic.get("differentiation_chain_rule")?.occurrences).toBe(3);
    expect(byTopic.get("fractions")?.occurrences).toBe(2);
    expect(byTopic.get("sign_errors")?.occurrences).toBe(1);

    const reviews = data.tasks.filter(
      (task) => task.kind === "review" && task.origin === "weak_spot"
    );
    expect(reviews.length).toBe(1);
    const review = reviews[0]!;
    expect(review.weakSpotKey).toBe("chain_rule");
    expect(review.dueAt).not.toBeNull();
    // Tomorrow 23:59 SGT, same as scheduleReview(3) produces.
    expect(sgtDayIndex(review.dueAt!)).toBe(sgtDayIndex(NOW.toISOString()) + 1);

    // The weak spot's next review matches the task, and the review task has
    // its practice starter.
    expect(byTopic.get("differentiation_chain_rule")?.nextReviewAt).toBe(review.dueAt);
    const practice = data.starters.find(
      (s) => s.taskKey === review.key && s.starter.type === "review_practice"
    );
    expect(practice).toBeDefined();
  });

  test("no em or en dashes anywhere in the data", () => {
    const strings = collectStrings(data);
    expect(strings.length).toBeGreaterThan(50);
    for (const text of strings) {
      expect(text.includes("\u2014")).toBe(false);
      expect(text.includes("\u2013")).toBe(false);
    }
  });

  test("every demo upload carries the reset marker", () => {
    expect(data.uploads.length).toBe(2);
    expect(DEMO_UPLOAD_MARKER).toBe("settle-demo-seed");
  });
});

describe("parseSeedArgs", () => {
  const allowed = [111111111, 222222222];

  test("defaults to a dry run for the first allowed id", () => {
    const parsed = parseSeedArgs([], allowed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.apply).toBe(false);
      expect(parsed.args.reset).toBe(false);
      expect(parsed.args.telegramId).toBe(111111111);
      expect(parsed.args.name).toBeNull();
    }
  });

  test("accepts --yes, --reset, an explicit id and a name", () => {
    const parsed = parseSeedArgs(
      ["--reset", "--yes", "--telegram-id", "222222222", "--name", "Wei Lun"],
      allowed
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.apply).toBe(true);
      expect(parsed.args.reset).toBe(true);
      expect(parsed.args.telegramId).toBe(222222222);
      expect(parsed.args.name).toBe("Wei Lun");
    }
  });

  test("rejects an id outside the allowlist", () => {
    const parsed = parseSeedArgs(["--telegram-id", "999999999"], allowed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("ALLOWED_TELEGRAM_IDS");
  });

  test("rejects a missing --telegram-id value and unknown flags", () => {
    const missingValue = parseSeedArgs(["--telegram-id"], allowed);
    expect(missingValue.ok).toBe(false);
    if (!missingValue.ok) expect(missingValue.error).toContain("--telegram-id needs a value");

    const unknown = parseSeedArgs(["--force"], allowed);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("--force");

    const empty = parseSeedArgs([], []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("ALLOWED_TELEGRAM_IDS is empty");
  });
});

describe("formatDryRunPlan", () => {
  const data = buildDemoData(NOW);
  const args = { apply: false, reset: true, telegramId: 111111111, name: null };

  test("prints counts and the project host but never a secret", () => {
    const fakeUrl = "https://demoproject.supabase.co";
    const fakeServiceKey = "sb_secret_FAKE_SERVICE_KEY";
    const fakeModelKey = "FAKE_MODEL_API_KEY";

    const lines = formatDryRunPlan(args, data, {
      SUPABASE_URL: fakeUrl,
      SUPABASE_SECRET_KEY: fakeServiceKey,
      MODEL_API_KEY: fakeModelKey,
    });
    const text = lines.join("\n");

    expect(text).not.toContain(fakeServiceKey);
    expect(text).not.toContain(fakeModelKey);
    expect(text).toContain("demoproject.supabase.co");
    expect(text).toContain("111111111");
    expect(text).toContain(`${data.tasks.length} tasks`);
    expect(text).toContain(`${data.taskEvents.length} task events`);
    expect(text).toContain(`${data.starters.length} starters`);
    expect(text).toContain(`${data.weakSpots.length} weak spots`);
    expect(text).toContain("--yes");
    expect(text).toContain("nothing has been written");
  });
});

describe("demoTerms", () => {
  test("the seeded user counts as accepted by the consent gate", async () => {
    const { hasAcceptedCurrentTerms } = await import("../../lib/legal/consent");
    const terms = demoTerms(NOW);
    expect(terms.termsAcceptedAt).toBe(NOW);
    expect(terms.termsVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      hasAcceptedCurrentTerms({
        terms_accepted_at: terms.termsAcceptedAt.toISOString(),
        terms_version: terms.termsVersion,
      }),
    ).toBe(true);
  });
});
