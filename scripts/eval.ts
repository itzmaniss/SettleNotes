// Eval harness CLI. Dry run (default) needs no keys, reads no env, makes no
// network calls. Live runs are the manager's job: `bun run eval -- <suite> --live`.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  addUsage,
  buildLiveCommand,
  buildUsage,
  createTotals,
  dirnameOf,
  dryRunReport,
  fixtureDirs,
  formatUsd,
  loadFixtures,
  matchUnderstand,
  parseEvalArgs,
  resolveAttachments,
  evalHeader,
  type AnyLoadedFixture,
  type DryRunFixtureInfo,
  type UnderstandFixture,
} from "./eval-match";
import type { UnderstandArgs } from "../lib/pipeline/understand";

const FIXTURES_ROOT = join(import.meta.dir, "..", "tests", "fixtures");

type SuiteRunner = (fixtures: AnyLoadedFixture[], opts: { maxUsd: number }) => Promise<number>;

// Later cards plug runners in here; estUsdPerFixture comes from ARCHITECTURE 7.
const SUITES: Record<string, { estUsdPerFixture: number; run: SuiteRunner | null }> = {
  understand: { estUsdPerFixture: 0.01, run: runUnderstandLive },
  math: { estUsdPerFixture: 0.05, run: null },
  checklist: { estUsdPerFixture: 0.06, run: null },
  flashcards: { estUsdPerFixture: 0.06, run: null },
};

function toDryInfo(fixtures: AnyLoadedFixture[]): DryRunFixtureInfo[] {
  return fixtures.map((f) => {
    const fx = f.fixture as UnderstandFixture;
    const attachments = resolveAttachments(fx, dirnameOf(f));
    return {
      id: f.id,
      file: f.file,
      sourceDir: f.sourceDir,
      text: fx.text ?? null,
      hasImage: attachments.image != null,
      hasPdf: attachments.pdf != null,
    };
  });
}

function imageMimeType(file: string): string {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function buildUnderstandArgs(
  f: AnyLoadedFixture,
  opts: { textModel?: string; textEffort?: "minimal" | "low" | "medium" } = {},
): UnderstandArgs {
  const fx = f.fixture as UnderstandFixture;
  const attachments = resolveAttachments(fx, dirnameOf(f));
  return {
    now: new Date(fx.now),
    openTasks: fx.openTasks.map((t) => ({
      id: t.id,
      title: t.title,
      course: t.course ?? null,
      kind: t.kind,
      due_at: t.due_at ?? null,
    })),
    text: fx.text ?? null,
    image: attachments.image
      ? { base64: readFileSync(attachments.image).toString("base64"), mimeType: imageMimeType(attachments.image) }
      : undefined,
    pdf: attachments.pdf
      ? { base64: readFileSync(attachments.pdf).toString("base64"), filename: basename(attachments.pdf) }
      : undefined,
    recentExchange: fx.recentExchange?.map((turn) => ({ role: turn.role, text: turn.text })),
    // From META_TEXT_MODEL / META_TEXT_EFFORT so the same env vars steer the
    // eval and the bot. Undefined here means the defaults, exactly as before.
    ...(opts.textModel != null ? { textModel: opts.textModel } : {}),
    ...(opts.textEffort != null ? { textEffort: opts.textEffort } : {}),
  };
}

async function runUnderstandLive(fixtures: AnyLoadedFixture[], opts: { maxUsd: number }): Promise<number> {
  // Imported lazily so a dry run never loads env or the API client.
  const [envMod, metaMod, { understand }] = await Promise.all([
    import("../lib/env"),
    import("../lib/meta/client"),
    import("../lib/pipeline/understand"),
  ]);
  const e = envMod.getEnv();
  // The optional text-only speed setting; unset values keep today's behaviour
  // (client default model at effort low).
  const textModel = e.META_TEXT_MODEL;
  const textEffort = e.META_TEXT_EFFORT;
  const totals = createTotals();
  const openai = metaMod.createOpenAIClient(e.MODEL_API_KEY, e.META_API_BASE_URL);
  const client = metaMod.createMetaClient({
    openai,
    model: e.META_MODEL,
    dailyBudgetUsd: e.META_DAILY_BUDGET_USD,
    // In-memory ledger instead of ai_calls: the eval run's own spend doubles
    // as "today's spend" for the client's budget guard.
    logAiCall: async (row) => {
      addUsage(totals, row);
    },
    getTodaySpend: async () => totals.costUsd,
  });

  console.log(evalHeader(e.META_MODEL, textModel, textEffort).join("\n"));
  console.log("");

  let passed = 0;
  let failed = 0;
  let stopped = false;

  for (const [index, f] of fixtures.entries()) {
    if (totals.costUsd > opts.maxUsd) {
      console.log(
        `\nstopped early: spend ${formatUsd(totals.costUsd)} passed --max-usd ${formatUsd(opts.maxUsd)} after ${index} of ${fixtures.length} fixtures`,
      );
      stopped = true;
      break;
    }
    const fx = f.fixture as UnderstandFixture;
    try {
      const result = await understand(
        { generateObject: client.generateObject },
        buildUnderstandArgs(f, { ...(textModel != null ? { textModel } : {}), ...(textEffort != null ? { textEffort } : {}) }),
      );
      const match = matchUnderstand(fx.expected, result.output);
      if (match.pass) {
        passed += 1;
        console.log(`PASS ${f.id}  (${result.usage.latencyMs} ms, ${formatUsd(result.usage.costUsd)})`);
      } else {
        failed += 1;
        console.log(`FAIL ${f.id}  (${result.usage.latencyMs} ms, ${formatUsd(result.usage.costUsd)})`);
        for (const reason of match.reasons) console.log(`  ${reason}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${f.id}  (- ms, $-)`);
      console.log(`  error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof metaMod.BudgetExceededError) {
        console.log("\nstopped early: daily budget guard refused further calls");
        break;
      }
    }
  }

  console.log("");
  console.log(`summary: ${passed}/${passed + failed} passed, ${failed} failed${stopped ? " (run stopped early)" : ""}`);
  console.log(`tokens: input ${totals.inputTokens} (cached ${totals.cachedTokens}), output ${totals.outputTokens}`);
  console.log(`cost: ${formatUsd(totals.costUsd)} across ${totals.calls} API call(s)`);
  return failed > 0 ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseEvalArgs(argv);
  if (args.help || args.errors.length > 0 || args.unknownFlags.length > 0 || args.suite == null) {
    console.log(buildUsage());
    for (const error of args.errors) console.error(`error: ${error}`);
    if (args.unknownFlags.length > 0) console.error(`error: unknown flag(s): ${args.unknownFlags.join(", ")}`);
    if (args.suite == null && !args.help) console.error("error: missing suite");
    return 1;
  }
  const suite = args.suite;
  const entry = SUITES[suite];
  if (!entry) {
    console.error(`error: unknown suite "${suite}". Valid suites: ${Object.keys(SUITES).join(", ")}`);
    console.log(buildUsage());
    return 1;
  }

  const dirs = fixtureDirs(suite, FIXTURES_ROOT);
  let fixtures: AnyLoadedFixture[];
  try {
    fixtures = loadFixtures(suite, { fixturesRoot: FIXTURES_ROOT, limit: args.limit });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!args.live) {
    console.log(
      dryRunReport({
        suite,
        fixtures: toDryInfo(fixtures),
        estUsdPerFixture: entry.estUsdPerFixture,
        liveCommand: buildLiveCommand(suite, args.limit),
        maxUsd: args.maxUsd,
        searchedDirs: [dirs.main, dirs.real],
      }),
    );
    return 0;
  }

  if (fixtures.length === 0) {
    console.log(`no fixtures found for suite "${suite}". Looked in: ${dirs.main}, ${dirs.real}`);
    return 0;
  }
  if (!entry.run) {
    console.log("suite runner not wired yet (arrives with the starter cards).");
    console.log(`Fixtures found: ${fixtures.length}. Dry run works: drop --live.`);
    return 1;
  }
  return entry.run(fixtures, { maxUsd: args.maxUsd });
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
