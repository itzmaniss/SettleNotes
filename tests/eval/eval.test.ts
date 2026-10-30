import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_USD,
  addUsage,
  buildLiveCommand,
  buildUsage,
  createTotals,
  dirnameOf,
  dryRunReport,
  formatUsd,
  loadFixtures,
  matchUnderstand,
  parseEvalArgs,
  resolveAttachments,
  type LoadedFixture,
  type UnderstandFixture,
} from "../../scripts/eval-match";
import { main } from "../../scripts/eval";
import type { UnderstandAction, UnderstandOutput } from "../../lib/pipeline/understand";

function action(overrides: Partial<UnderstandAction> = {}): UnderstandAction {
  return {
    type: "update",
    task_ref: "T1",
    title: null,
    course: null,
    kind: null,
    due_local: null,
    effort: null,
    evidence: "prof say extend",
    confidence: 0.9,
    ...overrides,
  };
}

function output(overrides: Partial<UnderstandOutput> = {}): UnderstandOutput {
  return {
    input_kind: "plain_message",
    extracted_text: "prof say extend lab 4",
    actions: [],
    needs_clarification: null,
    ...overrides,
  };
}

function runMatch(expectedActions: Parameters<typeof matchUnderstand>[0]["actions"], actual: UnderstandOutput) {
  return matchUnderstand({ actions: expectedActions, needs_clarification: false }, actual);
}

describe("matchUnderstand", () => {
  test("exact match passes", () => {
    const m = runMatch(
      [{ type: "update", task_ref: "T1", due_local: "2026-11-06T23:59" }],
      output({ actions: [action({ due_local: "2026-11-06T23:59" })] }),
    );
    expect(m.pass).toBe(true);
    expect(m.reasons).toEqual([]);
  });

  test("wrong type fails", () => {
    const m = runMatch(
      [{ type: "update", task_ref: "T1" }],
      output({ actions: [action({ type: "create", task_ref: null, title: "CS2030 Lab 4" })] }),
    );
    expect(m.pass).toBe(false);
    expect(m.reasons.some((r) => r.startsWith("missing action: update"))).toBe(true);
    expect(m.reasons.some((r) => r.startsWith("extra action: create"))).toBe(true);
  });

  test("wrong due_local fails with a specific reason", () => {
    const m = runMatch(
      [{ type: "update", task_ref: "T1", due_local: "2026-11-06T23:59" }],
      output({ actions: [action({ due_local: "2026-11-13T23:59" })] }),
    );
    expect(m.pass).toBe(false);
    expect(m.reasons.join("\n")).toContain("due_local: expected 2026-11-06T23:59, actual 2026-11-13T23:59");
  });

  test("title matches as case-insensitive substring in either direction", () => {
    const short = runMatch(
      [{ type: "create", title: "lab 4" }],
      output({ actions: [action({ type: "create", task_ref: null, title: "CS2030 Lab 4" })] }),
    );
    expect(short.pass).toBe(true);

    const long = runMatch(
      [{ type: "create", title: "CS2030 Lab 4" }],
      output({ actions: [action({ type: "create", task_ref: null, title: "lab 4" })] }),
    );
    expect(long.pass).toBe(true);
  });

  test("title mismatch fails", () => {
    const m = runMatch(
      [{ type: "create", title: "lab 5" }],
      output({ actions: [action({ type: "create", task_ref: null, title: "CS2030 Lab 4" })] }),
    );
    expect(m.pass).toBe(false);
    expect(m.reasons.join("\n")).toContain("title:");
  });

  test("two expected actions are matched by distinct actual actions", () => {
    const m = runMatch(
      [
        { type: "update", task_ref: "T1", due_local: "2026-11-06T23:59" },
        { type: "update", task_ref: "T2", due_local: "2026-11-20T23:59" },
      ],
      output({
        actions: [
          action({ task_ref: "T2", due_local: "2026-11-20T23:59" }),
          action({ task_ref: "T1", due_local: "2026-11-06T23:59" }),
        ],
      }),
    );
    expect(m.pass).toBe(true);
  });

  test("two expected actions cannot share one actual action", () => {
    const m = runMatch(
      [
        { type: "update", task_ref: "T1", due_local: "2026-11-06T23:59" },
        { type: "update", task_ref: "T2", due_local: "2026-11-20T23:59" },
      ],
      output({
        actions: [action({ task_ref: "T1", due_local: "2026-11-06T23:59" })],
      }),
    );
    expect(m.pass).toBe(false);
    expect(m.reasons.join("\n")).toContain("missing action: update T2");
  });

  test("extra actual action fails", () => {
    const m = runMatch(
      [{ type: "update", task_ref: "T1", due_local: "2026-11-06T23:59" }],
      output({
        actions: [action({ due_local: "2026-11-06T23:59" }), action({ type: "create", task_ref: null, title: "Extra" })],
      }),
    );
    expect(m.pass).toBe(false);
    expect(m.reasons.some((r) => r.startsWith("extra action: create"))).toBe(true);
  });

  test("none is ignored on both sides", () => {
    const m = runMatch(
      [{ type: "none" }],
      output({ actions: [action({ type: "none", task_ref: null, evidence: "noise" })] }),
    );
    expect(m.pass).toBe(true);
  });

  test("expected none but actual emits a real action fails", () => {
    const m = runMatch(
      [{ type: "none" }],
      output({ actions: [action({ type: "create", task_ref: null, title: "Something" })] }),
    );
    expect(m.pass).toBe(false);
    expect(m.reasons[0]).toContain("expected no actions, model emitted 1");
  });

  test("expected no actions and actual has none passes", () => {
    const m = runMatch([], output({ actions: [] }));
    expect(m.pass).toBe(true);
  });

  test("needs_clarification true requires a non-empty string", () => {
    const pass = matchUnderstand(
      { actions: [], needs_clarification: true },
      output({ needs_clarification: "Which tutorial group is this for?" }),
    );
    expect(pass.pass).toBe(true);

    const fail = matchUnderstand({ actions: [], needs_clarification: true }, output({ needs_clarification: null }));
    expect(fail.pass).toBe(false);
    expect(fail.reasons[0]).toContain("needs_clarification");
  });

  test("needs_clarification false fails when the model asks", () => {
    const m = matchUnderstand(
      { actions: [], needs_clarification: false },
      output({ needs_clarification: "What course is this?" }),
    );
    expect(m.pass).toBe(false);
    expect(m.reasons[0]).toContain("What course is this?");
  });

  test("null and empty needs_clarification both satisfy false", () => {
    expect(matchUnderstand({ actions: [], needs_clarification: false }, output()).pass).toBe(true);
    expect(matchUnderstand({ actions: [], needs_clarification: false }, output({ needs_clarification: "  " })).pass).toBe(
      true,
    );
  });
});

describe("fixture loader", () => {
  const root = mkdtempSync(join(tmpdir(), "settle-eval-test-"));
  // Invalid fixtures live under a separate root so happy-path loads of `root`
  // are not poisoned by them.
  const badRoot = mkdtempSync(join(tmpdir(), "settle-eval-test-bad-"));
  const schemaRoot = mkdtempSync(join(tmpdir(), "settle-eval-test-schema-"));
  const validUnderstand = JSON.stringify({
    id: "extend-nxt-fri",
    now: "2026-10-28T09:00:00+08:00",
    openTasks: [{ id: "task-1", title: "CS2030 Lab 4", course: "CS2030", kind: "assignment", due_at: "2026-10-30T15:59:00.000Z" }],
    text: "prof say extend lab 4 to nxt fri liao",
    image: "imgs/chat.jpg",
    expected: {
      actions: [{ type: "update", task_ref: "T1", due_local: "2026-11-06T23:59" }],
      needs_clarification: false,
    },
  });

  mkdirSync(join(root, "understand", "imgs"), { recursive: true });
  mkdirSync(join(root, "real", "understand"), { recursive: true });
  mkdirSync(join(root, "math"), { recursive: true });
  writeFileSync(join(root, "understand", "b-second.json"), validUnderstand);
  writeFileSync(
    join(root, "understand", "a-first.json"),
    JSON.stringify({
      id: "plain-none",
      now: "2026-10-28T09:00:00+08:00",
      text: "haha nice la",
      expected: { actions: [{ type: "none" }], needs_clarification: false },
    }),
  );
  writeFileSync(
    join(root, "real", "understand", "c-real.json"),
    JSON.stringify({
      id: "real-screenshot",
      now: "2026-10-28T09:00:00+08:00",
      text: "tmr quiz leh",
      expected: { actions: [], needs_clarification: false },
    }),
  );
  writeFileSync(join(root, "real", "understand", "labels.json"), JSON.stringify({ note: "not a fixture" }));
  mkdirSync(join(root, "math"), { recursive: true });
  writeFileSync(
    join(root, "math", "01-diagnosis.json"),
    JSON.stringify({ id: "m1", expected: { first_error_step: 2 } }),
  );
  mkdirSync(join(badRoot, "understand"), { recursive: true });
  writeFileSync(join(badRoot, "understand", "aaa-bad.json"), "{oops");
  mkdirSync(join(schemaRoot, "understand"), { recursive: true });
  writeFileSync(
    join(schemaRoot, "understand", "bad-schema.json"),
    JSON.stringify({ id: "missing-expected", now: "2026-10-28T09:00:00+08:00", text: "hi" }),
  );
  mkdirSync(join(badRoot, "math"), { recursive: true });
  writeFileSync(join(badRoot, "math", "02-no-id.json"), JSON.stringify({ noid: true }));

  test("loads both dirs, sorted by filename, real dir included, labels.json skipped", () => {
    const fixtures = loadFixtures("understand", { fixturesRoot: root });
    expect(fixtures.map((f) => f.id)).toEqual(["plain-none", "extend-nxt-fri", "real-screenshot"]);
    expect(fixtures.map((f) => f.sourceDir)).toEqual(["fixtures", "fixtures", "real"]);
  });

  test("limit applies after sorting", () => {
    const fixtures = loadFixtures("understand", { fixturesRoot: root, limit: 1 });
    expect(fixtures.map((f) => f.id)).toEqual(["plain-none"]);
  });

  test("understand fixtures validate against the schema and keep typed data", () => {
    const fixtures = loadFixtures("understand", { fixturesRoot: root, limit: 1 });
    const fx = fixtures[0].fixture as unknown as UnderstandFixture;
    expect(fx.now).toBe("2026-10-28T09:00:00+08:00");
    expect(fx.openTasks).toEqual([]);
    expect(fx.expected.needs_clarification).toBe(false);
  });

  test("invalid JSON names the file", () => {
    expect(() => loadFixtures("understand", { fixturesRoot: badRoot })).toThrow(/aaa-bad\.json/);
  });

  test("schema violation names the file", () => {
    expect(() => loadFixtures("understand", { fixturesRoot: schemaRoot })).toThrow(/bad-schema\.json/);
  });

  test("generic suite only needs an id and passes the rest through", () => {
    const fixtures = loadFixtures("math", { fixturesRoot: root }) as LoadedFixture<Record<string, unknown>>[];
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].id).toBe("m1");
    expect(fixtures[0].fixture).toMatchObject({ id: "m1", expected: { first_error_step: 2 } });
  });

  test("generic fixture without an id names the file", () => {
    expect(() => loadFixtures("math", { fixturesRoot: badRoot })).toThrow(/02-no-id\.json/);
  });

  test("unknown suite just finds nothing", () => {
    expect(loadFixtures("nonexistent", { fixturesRoot: root })).toEqual([]);
  });

  test("attachment paths resolve relative to the fixture file", () => {
    const fixtures = loadFixtures("understand", { fixturesRoot: root, limit: 1 });
    expect(fixtures[0].id).toBe("plain-none");
    const second = loadFixtures("understand", { fixturesRoot: root })[1];
    const attachments = resolveAttachments(second.fixture as unknown as UnderstandFixture, dirnameOf(second));
    expect(attachments.image).toBe(join(root, "understand", "imgs", "chat.jpg"));
    expect(attachments.pdf).toBeNull();
  });

  test("cleanup", () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(badRoot, { recursive: true, force: true });
    rmSync(schemaRoot, { recursive: true, force: true });
  });
});

describe("parseEvalArgs", () => {
  test("suite only", () => {
    const args = parseEvalArgs(["understand"]);
    expect(args.suite).toBe("understand");
    expect(args.live).toBe(false);
    expect(args.limit).toBeNull();
    expect(args.maxUsd).toBe(DEFAULT_MAX_USD);
    expect(args.errors).toEqual([]);
    expect(args.unknownFlags).toEqual([]);
  });

  test("all flags", () => {
    const args = parseEvalArgs(["math", "--limit", "3", "--live", "--max-usd", "0.5"]);
    expect(args.suite).toBe("math");
    expect(args.limit).toBe(3);
    expect(args.live).toBe(true);
    expect(args.maxUsd).toBe(0.5);
  });

  test("equals forms", () => {
    const args = parseEvalArgs(["--limit=5", "checklist", "--max-usd=1.25"]);
    expect(args.suite).toBe("checklist");
    expect(args.limit).toBe(5);
    expect(args.maxUsd).toBe(1.25);
  });

  test("missing suite", () => {
    expect(parseEvalArgs(["--live"]).suite).toBeNull();
    expect(parseEvalArgs([]).suite).toBeNull();
  });

  test("bad limit", () => {
    expect(parseEvalArgs(["understand", "--limit", "0"]).errors.length).toBeGreaterThan(0);
    expect(parseEvalArgs(["understand", "--limit", "abc"]).errors.length).toBeGreaterThan(0);
    expect(parseEvalArgs(["understand", "--limit"]).errors.length).toBeGreaterThan(0);
  });

  test("bad max-usd", () => {
    expect(parseEvalArgs(["understand", "--max-usd", "-1"]).errors.length).toBeGreaterThan(0);
    expect(parseEvalArgs(["understand", "--max-usd"]).errors.length).toBeGreaterThan(0);
  });

  test("unknown flag is collected", () => {
    const args = parseEvalArgs(["understand", "--wat"]);
    expect(args.unknownFlags).toEqual(["--wat"]);
  });

  test("extra positional argument is an error", () => {
    const args = parseEvalArgs(["understand", "math"]);
    expect(args.errors.length).toBeGreaterThan(0);
  });

  test("help flag", () => {
    expect(parseEvalArgs(["--help"]).help).toBe(true);
    expect(parseEvalArgs(["-h"]).help).toBe(true);
  });
});

describe("dry-run report", () => {
  const base = {
    suite: "understand",
    estUsdPerFixture: 0.01,
    liveCommand: buildLiveCommand("understand", null),
    maxUsd: 2,
    searchedDirs: ["/t/fixtures/understand", "/t/fixtures/real/understand"],
  };

  test("reports count, estimate and live command without mentioning keys", () => {
    const report = dryRunReport({
      ...base,
      fixtures: [
        { id: "a", file: "/t/fixtures/understand/a.json", sourceDir: "fixtures", text: "hello there", hasImage: false, hasPdf: false },
        { id: "b", file: "/t/fixtures/real/understand/b.json", sourceDir: "real", text: null, hasImage: true, hasPdf: true },
      ],
    });
    expect(report).toContain("fixtures: 2 (fixtures: 1, real: 1)");
    expect(report).toContain("text 11 chars");
    expect(report).toContain("image attached");
    expect(report).toContain("$0.02");
    expect(report).toContain("bun run eval -- understand --live");
    expect(report.toLowerCase()).not.toContain("api key");
    expect(report.toLowerCase()).not.toContain("key");
  });

  test("zero fixtures says so plainly", () => {
    const report = dryRunReport({ ...base, fixtures: [] });
    expect(report).toContain("no fixtures found");
    expect(report).toContain("/t/fixtures/understand");
  });
});

describe("cost totals", () => {
  test("accumulates across calls including failed calls with no usage", () => {
    const totals = createTotals();
    addUsage(totals, { inputTokens: 1000, outputTokens: 500, cachedTokens: 200, costUsd: 0.003 });
    addUsage(totals, { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null });
    expect(totals.calls).toBe(2);
    expect(totals.inputTokens).toBe(1000);
    expect(totals.outputTokens).toBe(500);
    expect(totals.cachedTokens).toBe(200);
    expect(totals.costUsd).toBeCloseTo(0.003, 6);
  });

  test("formatUsd keeps small costs visible", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0083)).toBe("$0.0083");
    expect(formatUsd(0.03)).toBe("$0.03");
  });
});

describe("cli", () => {
  test("usage text lists suites and flags", () => {
    const usage = buildUsage();
    for (const suite of ["understand", "math", "checklist", "flashcards"]) expect(usage).toContain(suite);
    for (const flag of ["--limit", "--live", "--max-usd"]) expect(usage).toContain(flag);
  });

  test("missing or unknown suite exits 1 without touching env", async () => {
    expect(await main([])).toBe(1);
    expect(await main(["bogus-suite"])).toBe(1);
  });

  test("live command includes limit when set", () => {
    expect(buildLiveCommand("understand", 5)).toBe("bun run eval -- understand --limit 5 --live");
    expect(buildLiveCommand("math", null)).toBe("bun run eval -- math --live");
  });
});
