// Pure helpers for scripts/eval.ts: fixture schemas + loading, arg parsing,
// output matching and cost accounting. Kept free of env access and network so
// tests can exercise everything offline.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { UnderstandAction, UnderstandOutput } from "../lib/pipeline/understand";

export const SUITE_NAMES = ["understand", "math", "checklist", "flashcards"] as const;
export type SuiteName = (typeof SUITE_NAMES)[number];

// ---------------------------------------------------------------- fixtures

const parseableTimestamp = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be a parseable ISO timestamp" });

const expectedActionSchema = z.object({
  type: z.enum(["create", "update", "complete", "none"]),
  task_ref: z.string().nullish(),
  title: z.string().nullish(),
  course: z.string().nullish(),
  kind: z.string().nullish(),
  due_local: z.string().nullish(),
  effort: z.string().nullish(),
});

export type ExpectedAction = z.infer<typeof expectedActionSchema>;

export const understandFixtureSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  now: parseableTimestamp,
  openTasks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        course: z.string().nullish(),
        kind: z.string(),
        due_at: parseableTimestamp.nullish(),
      }),
    )
    .default([]),
  text: z.string().nullish(),
  image: z.string().optional(),
  pdf: z.string().optional(),
  expected: z.object({
    actions: z.array(expectedActionSchema).default([]),
    needs_clarification: z.boolean(),
  }),
});

export type UnderstandFixture = z.infer<typeof understandFixtureSchema>;

// math/checklist/flashcards fixtures are free-form user files for now; only
// the id is load-bearing.
const genericFixtureSchema = z.looseObject({ id: z.string().min(1) });

export type LoadedFixture<T = Record<string, unknown>> = {
  suite: string;
  /** Absolute path of the fixture file. */
  file: string;
  name: string;
  /** "fixtures" for tests/fixtures/<suite>/, "real" for tests/fixtures/real/<suite>/. */
  sourceDir: "fixtures" | "real";
  id: string;
  fixture: T;
};

export type AnyLoadedFixture = LoadedFixture<UnderstandFixture> | LoadedFixture<Record<string, unknown>>;

export type LoadOptions = { fixturesRoot: string; limit?: number | null };

function listFixtureFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json") && n !== "labels.json")
    .sort();
}

function firstIssueMessage(file: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
  return `Invalid fixture ${file}${where}: ${issue ? issue.message : "validation failed"}`;
}

export function loadFixtures(suite: "understand", opts: LoadOptions): LoadedFixture<UnderstandFixture>[];
export function loadFixtures(suite: string, opts: LoadOptions): LoadedFixture<Record<string, unknown>>[];
export function loadFixtures(suite: string, opts: LoadOptions): LoadedFixture<unknown>[] {
  const sources: Array<{ dir: string; sourceDir: "fixtures" | "real" }> = [
    { dir: join(opts.fixturesRoot, suite), sourceDir: "fixtures" },
    { dir: join(opts.fixturesRoot, "real", suite), sourceDir: "real" },
  ];
  const loaded: LoadedFixture<unknown>[] = [];
  for (const src of sources) {
    for (const name of listFixtureFiles(src.dir)) {
      const file = join(src.dir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid fixture ${file}: not valid JSON (${detail})`);
      }
      if (suite === "understand") {
        const parsed = understandFixtureSchema.safeParse(raw);
        if (!parsed.success) throw new Error(firstIssueMessage(file, parsed.error));
        loaded.push({ suite, file, name, sourceDir: src.sourceDir, id: parsed.data.id, fixture: parsed.data });
      } else {
        const parsed = genericFixtureSchema.safeParse(raw);
        if (!parsed.success) throw new Error(firstIssueMessage(file, parsed.error));
        loaded.push({ suite, file, name, sourceDir: src.sourceDir, id: parsed.data.id, fixture: parsed.data });
      }
    }
  }
  // Filename order across both dirs; same name in both dirs keeps main first.
  loaded.sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.sourceDir === b.sourceDir ? 0 : a.sourceDir === "fixtures" ? -1 : 1),
  );
  if (opts.limit != null) return loaded.slice(0, Math.max(0, opts.limit));
  return loaded;
}

export function fixtureDirs(suite: string, fixturesRoot: string): { main: string; real: string } {
  return { main: join(fixturesRoot, suite), real: join(fixturesRoot, "real", suite) };
}

/** Attachment paths are stored relative to the fixture file's own directory. */
export function resolveAttachments(
  fixture: { image?: string; pdf?: string },
  fixtureDir: string,
): { image: string | null; pdf: string | null } {
  return {
    image: fixture.image ? resolve(fixtureDir, fixture.image) : null,
    pdf: fixture.pdf ? resolve(fixtureDir, fixture.pdf) : null,
  };
}

export function dirnameOf(fixture: { file: string }): string {
  return dirname(fixture.file);
}

// ---------------------------------------------------------------- matching

export type MatchResult = { pass: boolean; reasons: string[] };

const EXACT_FIELDS = ["task_ref", "course", "kind", "effort", "due_local"] as const;
type ExactField = (typeof EXACT_FIELDS)[number];

function norm(v: string | null | undefined): string | null {
  return v == null || v === "" ? null : v;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function titleMatches(expectedTitle: string, actualTitle: string | null | undefined): boolean {
  const e = expectedTitle.trim().toLowerCase();
  const a = (actualTitle ?? "").trim().toLowerCase();
  if (!e || !a) return false;
  return a.includes(e) || e.includes(a);
}

function actionMatches(exp: ExpectedAction, act: UnderstandAction): boolean {
  if (exp.type !== act.type) return false;
  for (const field of EXACT_FIELDS) {
    if (norm(exp[field]) !== norm(act[field as ExactField] as string | null | undefined)) return false;
  }
  const expectedTitle = exp.title?.trim();
  // A null expected title imposes no constraint; a non-null one needs a
  // case-insensitive substring match in either direction.
  if (expectedTitle && !titleMatches(expectedTitle, act.title)) return false;
  return true;
}

function describeAction(a: {
  type: string;
  task_ref?: string | null;
  title?: string | null;
  course?: string | null;
  kind?: string | null;
  effort?: string | null;
  due_local?: string | null;
}): string {
  const bits = [a.type];
  if (a.task_ref) bits.push(a.task_ref);
  if (a.title) bits.push(`title~"${truncate(a.title, 60)}"`);
  if (a.course) bits.push(`course=${a.course}`);
  if (a.kind) bits.push(`kind=${a.kind}`);
  if (a.effort) bits.push(`effort=${a.effort}`);
  if (a.due_local) bits.push(`due_local=${a.due_local}`);
  return bits.join(" ");
}

// When an expected action has no distinct match, point at the closest
// same-type candidate and name the differing fields.
function mismatchHint(exp: ExpectedAction, pool: UnderstandAction[], used: Set<number>): string {
  const index = pool.findIndex((a, i) => !used.has(i) && a.type === exp.type);
  if (index === -1) return "";
  const cand = pool[index];
  const diffs: string[] = [];
  for (const field of EXACT_FIELDS) {
    const e = norm(exp[field]);
    const c = norm(cand[field as ExactField] as string | null | undefined);
    if (e !== c) diffs.push(`${field}: expected ${e ?? "none"}, actual ${c ?? "none"}`);
  }
  const expectedTitle = exp.title?.trim();
  if (expectedTitle && !titleMatches(expectedTitle, cand.title)) {
    diffs.push(`title: expected something matching "${truncate(expectedTitle, 40)}", actual "${truncate(cand.title ?? "none", 40)}"`);
  }
  return diffs.length > 0 ? ` (closest ${exp.type}: ${diffs.join("; ")})` : "";
}

export function matchUnderstand(
  expected: { actions: ExpectedAction[]; needs_clarification: boolean },
  actual: UnderstandOutput,
): MatchResult {
  const reasons: string[] = [];
  const expectedActions = expected.actions.filter((a) => a.type !== "none");
  const pool = actual.actions.filter((a) => a.type !== "none");
  const used = new Set<number>();

  if (expectedActions.length === 0) {
    if (pool.length > 0) {
      reasons.push(`expected no actions, model emitted ${pool.length}: ${pool.map(describeAction).join("; ")}`);
    }
  } else {
    for (const exp of expectedActions) {
      let matched = -1;
      for (let i = 0; i < pool.length; i++) {
        if (!used.has(i) && actionMatches(exp, pool[i])) {
          matched = i;
          break;
        }
      }
      if (matched === -1) {
        reasons.push(`missing action: ${describeAction(exp)}${mismatchHint(exp, pool, used)}`);
      } else {
        used.add(matched);
      }
    }
    for (let i = 0; i < pool.length; i++) {
      if (!used.has(i)) reasons.push(`extra action: ${describeAction(pool[i])}`);
    }
  }

  const asked = typeof actual.needs_clarification === "string" && actual.needs_clarification.trim().length > 0;
  if (expected.needs_clarification && !asked) {
    reasons.push("needs_clarification: expected a question, model gave none");
  }
  if (!expected.needs_clarification && asked) {
    reasons.push(`needs_clarification: model asked "${truncate(actual.needs_clarification ?? "", 80)}" but fixture expects none`);
  }

  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------- args

export const DEFAULT_MAX_USD = 2;

export type EvalArgs = {
  suite: string | null;
  limit: number | null;
  live: boolean;
  maxUsd: number;
  help: boolean;
  unknownFlags: string[];
  errors: string[];
};

export function parseEvalArgs(argv: string[]): EvalArgs {
  const out: EvalArgs = {
    suite: null,
    limit: null,
    live: false,
    maxUsd: DEFAULT_MAX_USD,
    help: false,
    unknownFlags: [],
    errors: [],
  };
  let suiteSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") {
      out.live = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    let flag = arg;
    let inline: string | null = null;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flag = arg.slice(0, eq);
        inline = arg.slice(eq + 1);
      }
    }
    if (flag === "--limit") {
      const raw = inline ?? argv[++i];
      const n = raw == null ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) out.errors.push(`--limit needs a positive integer, got ${raw ?? "(missing)"}`);
      else out.limit = n;
      continue;
    }
    if (flag === "--max-usd") {
      const raw = inline ?? argv[++i];
      const n = raw == null ? Number.NaN : Number(raw);
      if (!Number.isFinite(n) || n <= 0) out.errors.push(`--max-usd needs a positive number, got ${raw ?? "(missing)"}`);
      else out.maxUsd = n;
      continue;
    }
    if (arg.startsWith("--")) {
      out.unknownFlags.push(arg);
      continue;
    }
    if (!suiteSeen) {
      out.suite = arg;
      suiteSeen = true;
    } else {
      out.errors.push(`unexpected extra argument: ${arg}`);
    }
  }
  return out;
}

export function buildUsage(): string {
  return [
    "Settle eval harness",
    "",
    "Usage: bun run eval -- <suite> [--limit n] [--live] [--max-usd x]",
    "",
    `Suites: ${SUITE_NAMES.join(" | ")}`,
    "",
    "  --limit n     Only run the first n fixtures (after sorting by filename)",
    "  --live        Actually call the Meta API (default: dry run, no keys needed)",
    "  --max-usd x   Abort a live run once cumulative cost passes x USD (default 2)",
    "",
    "Dry run prints what would run and the estimated cost. The manager runs live evals.",
  ].join("\n");
}

// ---------------------------------------------------------------- cost

export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
};

export function createTotals(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
}

export function addUsage(
  totals: UsageTotals,
  u: { inputTokens?: number | null; outputTokens?: number | null; cachedTokens?: number | null; costUsd?: number | null },
): void {
  totals.calls += 1;
  totals.inputTokens += u.inputTokens ?? 0;
  totals.outputTokens += u.outputTokens ?? 0;
  totals.cachedTokens += u.cachedTokens ?? 0;
  totals.costUsd += u.costUsd ?? 0;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}

// ---------------------------------------------------------------- dry run

export type DryRunFixtureInfo = {
  id: string;
  file: string;
  sourceDir: string;
  text?: string | null;
  hasImage: boolean;
  hasPdf: boolean;
};

export function dryRunReport(input: {
  suite: string;
  fixtures: DryRunFixtureInfo[];
  estUsdPerFixture: number;
  liveCommand: string;
  maxUsd: number;
  searchedDirs: string[];
}): string {
  const lines: string[] = [];
  lines.push(`eval dry run, suite "${input.suite}" (no API calls made)`);
  if (input.fixtures.length === 0) {
    lines.push(`no fixtures found. Looked in: ${input.searchedDirs.join(", ")}`);
  } else {
    const bySource = new Map<string, number>();
    for (const f of input.fixtures) bySource.set(f.sourceDir, (bySource.get(f.sourceDir) ?? 0) + 1);
    const breakdown = [...bySource.entries()].map(([dir, n]) => `${dir}: ${n}`).join(", ");
    lines.push(`fixtures: ${input.fixtures.length} (${breakdown})`);
    input.fixtures.forEach((f, i) => {
      lines.push(`  ${i + 1}. ${f.id}  ${f.file}`);
      const parts = [
        f.text ? `text ${f.text.length} chars` : "no text",
        `image ${f.hasImage ? "attached" : "no"}`,
        `pdf ${f.hasPdf ? "attached" : "no"}`,
      ];
      lines.push(`     ${parts.join(", ")}`);
    });
    lines.push(
      `estimated cost: ${input.fixtures.length} fixtures x ${formatUsd(input.estUsdPerFixture)} = ${formatUsd(
        input.fixtures.length * input.estUsdPerFixture,
      )} (rough per-fixture estimate)`,
    );
  }
  lines.push(`live command: ${input.liveCommand}`);
  lines.push(`cost guard: a live run stops once spend passes ${formatUsd(input.maxUsd)} (override with --max-usd)`);
  return lines.join("\n");
}

export function buildLiveCommand(suite: string, limit: number | null): string {
  return `bun run eval -- ${suite}${limit != null ? ` --limit ${limit}` : ""} --live`;
}
