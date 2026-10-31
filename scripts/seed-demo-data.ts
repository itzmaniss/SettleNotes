// Pure demo data for scripts/seed-demo.ts: no I/O, no env, no db client, so
// tests can build and validate the whole demo world without touching anything.
// Every date is derived from the `now` argument on Singapore calendar days
// (fixed UTC+8), so the dashboard buckets land the same way at any run time.

import type {
  TaskEffort,
  TaskKind,
  TaskOrigin,
  TaskStatus,
  UploadClassifiedAs,
  UploadKind,
} from "../lib/db/types";
import type { StarterContent } from "../lib/starters/types";

// ---------- shapes ----------

// Every demo upload carries this marker in text_content, so --reset can find
// and delete exactly what the seed created and nothing else.
export const DEMO_UPLOAD_MARKER = "settle-demo-seed";

export type DemoUpload = {
  key: string;
  kind: UploadKind;
  mimeType: string | null;
  classifiedAs: UploadClassifiedAs | null;
  createdAt: string;
};

export type DemoTask = {
  key: string;
  title: string;
  course: string | null;
  kind: TaskKind;
  dueAt: string | null;
  effort: TaskEffort | null;
  status: TaskStatus;
  origin: TaskOrigin;
  uploadKey: string | null;
  weakSpotKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DemoTaskEvent = {
  taskKey: string;
  action: "created" | "updated" | "completed";
  // Same field names the real pipeline writes (lib/pipeline/reconcile.ts).
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  evidence: string | null;
  uploadKey: string | null;
  createdAt: string;
};

export type DemoStarter = {
  taskKey: string;
  starter: StarterContent;
  annotated: boolean;
};

export type DemoWeakSpot = {
  key: string;
  topic: string;
  latestMisconception: string;
  occurrences: number;
  lastSeenAt: string;
  nextReviewAt: string | null;
};

// What the I/O layer needs to draw and upload the annotated math photo.
// ringBox is in pixels of a width x height canvas on a 0-1000 grounding grid.
export type DemoAnnotatedImage = {
  width: number;
  height: number;
  ringBox: { left: number; top: number; width: number; height: number };
};

export type DemoData = {
  displayName: string | null;
  uploads: DemoUpload[];
  tasks: DemoTask[];
  taskEvents: DemoTaskEvent[];
  starters: DemoStarter[];
  weakSpots: DemoWeakSpot[];
  annotatedImage: DemoAnnotatedImage;
};

export type BuildDemoDataOpts = { demoName?: string };

// ---------- SGT date helpers ----------

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function sgtDayIndex(t: Date): number {
  return Math.floor((t.getTime() + SGT_OFFSET_MS) / DAY_MS);
}

function sgtWeekdayMonday0(t: Date): number {
  return (((sgtDayIndex(t) + 3) % 7) + 7) % 7;
}

// A moment on SGT day (today + offsetDays) at hh:mm, as a UTC ISO string.
function sgtMoment(now: Date, offsetDays: number, hour: number, minute: number): string {
  const dayStart = (sgtDayIndex(now) + offsetDays) * DAY_MS - SGT_OFFSET_MS;
  return new Date(dayStart + (hour * 60 + minute) * 60 * 1000).toISOString();
}

// Deadlines sit at 23:59 SGT like the real pipeline writes them.
function dueAtSgt(now: Date, offsetDays: number): string {
  return sgtMoment(now, offsetDays, 23, 59);
}

function createdAtSgt(now: Date, offsetDays: number): string {
  return sgtMoment(now, offsetDays, 20, 12);
}

// "nxt fri" = the Friday of next week (7 days later when today is Friday),
// the same rule the understand prompt encodes.
function nextFridaySgt(now: Date): string {
  const diff = 4 - sgtWeekdayMonday0(now);
  return dueAtSgt(now, diff + 7);
}

// This week's Wednesday, even when that is already in the past: the lab was
// originally due midweek before the prof extended it.
function thisWednesdaySgt(now: Date): string {
  return dueAtSgt(now, 2 - sgtWeekdayMonday0(now));
}

// ---------- shared misconception strings ----------

// One wording everywhere: diagnosis, weak spot, review starter and the review
// task's event evidence, exactly like recordWeakSpot reuses misconception.detail.
const CHAIN_RULE_MISCONCEPTION =
  "Differentiates the outer function but forgets to multiply by the derivative of the inner function.";

const CHAIN_RULE_PRACTICE = [
  {
    question: "Differentiate $y = (2x + 3)^4$.",
    answer: "$y' = 4(2x + 3)^3 \\cdot 2 = 8(2x + 3)^3$.",
  },
  {
    question: "Differentiate $y = \\sin(5x)$.",
    answer: "$y' = 5\\cos(5x)$.",
  },
  {
    question: "Differentiate $y = \\ln(x^2 + 1)$.",
    answer: "$y' = \\frac{2x}{x^2 + 1}$.",
  },
];

// ---------- builder ----------

export function buildDemoData(now: Date, opts: BuildDemoDataOpts = {}): DemoData {
  const lab4OriginalDue = thisWednesdaySgt(now);
  const lab4NewDue = nextFridaySgt(now);
  const reviewDue = dueAtSgt(now, 1); // tomorrow, same as scheduleReview(occurrences 3)

  const uploads: DemoUpload[] = [
    {
      key: "seed-anchor",
      kind: "text",
      mimeType: null,
      classifiedAs: "other",
      createdAt: createdAtSgt(now, -14),
    },
    {
      key: "math-photo",
      kind: "photo",
      mimeType: "image/jpeg",
      classifiedAs: "math_working",
      createdAt: createdAtSgt(now, -1),
    },
  ];

  const tasks: DemoTask[] = [
    {
      key: "ma2001_ps6",
      title: "MA2001 Problem Set 6",
      course: "MA2001",
      kind: "assignment",
      dueAt: dueAtSgt(now, -2),
      effort: "medium",
      status: "open",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -12),
      updatedAt: createdAtSgt(now, -12),
    },
    {
      key: "ee2026_prelab",
      title: "EE2026 pre-lab quiz 5",
      course: "EE2026",
      kind: "test",
      dueAt: dueAtSgt(now, 0),
      effort: "small",
      status: "open",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -1),
      updatedAt: createdAtSgt(now, -1),
    },
    {
      key: "st2334_report",
      title: "ST2334 project report",
      course: "ST2334",
      kind: "assignment",
      dueAt: dueAtSgt(now, 3),
      effort: "large",
      status: "open",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -6),
      updatedAt: createdAtSgt(now, -6),
    },
    {
      key: "ee2026_midterm",
      title: "EE2026 midterm",
      course: "EE2026",
      kind: "test",
      dueAt: dueAtSgt(now, 4),
      effort: "large",
      status: "open",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -5),
      updatedAt: createdAtSgt(now, -5),
    },
    {
      key: "cs2040_lab4",
      title: "CS2040 Lab 4",
      course: "CS2040",
      kind: "assignment",
      dueAt: lab4NewDue,
      effort: "medium",
      status: "open",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -9),
      updatedAt: sgtMoment(now, 0, 11, 24),
    },
    {
      key: "ma2001_ps7",
      title: "MA2001 Problem Set 7",
      course: "MA2001",
      kind: "assignment",
      dueAt: dueAtSgt(now, 9),
      effort: "medium",
      status: "open",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -2),
      updatedAt: createdAtSgt(now, -2),
    },
    {
      key: "ma2001_slides",
      title: "Revise: MA2001 week 10 slides",
      course: "MA2001",
      kind: "reading",
      dueAt: null,
      effort: null,
      status: "open",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -5),
      updatedAt: createdAtSgt(now, -5),
    },
    {
      key: "cs2040_tut7",
      title: "CS2040 Tutorial 7",
      course: "CS2040",
      kind: "assignment",
      dueAt: dueAtSgt(now, -4),
      effort: "small",
      status: "done",
      origin: "capture",
      uploadKey: "seed-anchor",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -6),
      updatedAt: sgtMoment(now, -4, 21, 40),
    },
    {
      key: "math_chain_rule",
      title: "Math check: Chain rule",
      course: null,
      kind: "math_practice",
      dueAt: null,
      effort: null,
      status: "open",
      origin: "capture",
      uploadKey: "math-photo",
      weakSpotKey: null,
      createdAt: createdAtSgt(now, -1),
      updatedAt: createdAtSgt(now, -1),
    },
    {
      key: "review_chain_rule",
      title: "Review: Chain rule",
      course: null,
      kind: "review",
      dueAt: reviewDue,
      effort: "small",
      status: "open",
      origin: "weak_spot",
      uploadKey: "math-photo",
      weakSpotKey: "chain_rule",
      createdAt: createdAtSgt(now, -1),
      updatedAt: createdAtSgt(now, -1),
    },
  ];

  const taskEvents: DemoTaskEvent[] = [
    {
      taskKey: "ma2001_ps6",
      action: "created",
      before: null,
      after: {
        title: "MA2001 Problem Set 6",
        course: "MA2001",
        kind: "assignment",
        dueAt: dueAtSgt(now, -2),
        effort: "medium",
      },
      evidence: "PS6 is out, due in two weeks, heavy on diagonalisation",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -12),
    },
    {
      taskKey: "ee2026_prelab",
      action: "created",
      before: null,
      after: {
        title: "EE2026 pre-lab quiz 5",
        course: "EE2026",
        kind: "test",
        dueAt: dueAtSgt(now, 0),
        effort: "small",
      },
      evidence: "prelab quiz 5 due tmr 2359, open book",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -1),
    },
    {
      taskKey: "st2334_report",
      action: "created",
      before: null,
      after: {
        title: "ST2334 project report",
        course: "ST2334",
        kind: "assignment",
        dueAt: dueAtSgt(now, 3),
        effort: "large",
      },
      evidence: "Report (25 percent) due Friday 2359, one PDF per team on Canvas",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -6),
    },
    {
      taskKey: "ee2026_midterm",
      action: "created",
      before: null,
      after: {
        title: "EE2026 midterm",
        course: "EE2026",
        kind: "test",
        dueAt: dueAtSgt(now, 4),
        effort: "large",
      },
      evidence: "midterm confirmed, everything from week 1 to 7 can come out",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -5),
    },
    {
      taskKey: "cs2040_lab4",
      action: "created",
      before: null,
      after: {
        title: "CS2040 Lab 4",
        course: "CS2040",
        kind: "assignment",
        dueAt: lab4OriginalDue,
        effort: "medium",
      },
      evidence: "Lab 4 is out, due Wednesday 2359, CodeCrunch closes sharp",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -9),
    },
    {
      taskKey: "cs2040_lab4",
      action: "updated",
      before: { dueAt: lab4OriginalDue },
      after: { dueAt: lab4NewDue },
      evidence: "prof say extend to nxt fri liao",
      uploadKey: null,
      createdAt: sgtMoment(now, 0, 11, 24),
    },
    {
      taskKey: "ma2001_ps7",
      action: "created",
      before: null,
      after: {
        title: "MA2001 Problem Set 7",
        course: "MA2001",
        kind: "assignment",
        dueAt: dueAtSgt(now, 9),
        effort: "medium",
      },
      evidence: "PS7 is released already, two weeks to do it",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -2),
    },
    {
      taskKey: "ma2001_slides",
      action: "created",
      before: null,
      after: {
        title: "Revise: MA2001 week 10 slides",
        course: "MA2001",
        kind: "reading",
        dueAt: null,
        effort: null,
      },
      evidence: "MA2001 week 10 slides.pdf",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -5),
    },
    {
      taskKey: "cs2040_tut7",
      action: "created",
      before: null,
      after: {
        title: "CS2040 Tutorial 7",
        course: "CS2040",
        kind: "assignment",
        dueAt: dueAtSgt(now, -4),
        effort: "small",
      },
      evidence: "Tut 7 questions are up",
      uploadKey: "seed-anchor",
      createdAt: createdAtSgt(now, -6),
    },
    {
      taskKey: "cs2040_tut7",
      action: "completed",
      before: { status: "open" },
      after: { status: "done" },
      evidence: "tut 7 done liao, submitted already",
      uploadKey: null,
      createdAt: sgtMoment(now, -4, 21, 40),
    },
    {
      taskKey: "math_chain_rule",
      action: "created",
      before: null,
      after: {
        title: "Math check: Chain rule",
        course: null,
        kind: "math_practice",
        dueAt: null,
        effort: null,
      },
      evidence:
        "The chain rule was applied halfway. The derivative of the inner function u = 3x + 1 was never multiplied in, so the final line is missing the factor of 3.",
      uploadKey: "math-photo",
      createdAt: createdAtSgt(now, -1),
    },
    {
      taskKey: "review_chain_rule",
      action: "created",
      before: null,
      after: {
        title: "Review: Chain rule",
        course: null,
        kind: "review",
        dueAt: reviewDue,
        effort: "small",
      },
      evidence: CHAIN_RULE_MISCONCEPTION,
      uploadKey: null,
      createdAt: createdAtSgt(now, -1),
    },
  ];

  const starters: DemoStarter[] = [
    {
      taskKey: "st2334_report",
      annotated: false,
      starter: {
        type: "checklist",
        content: {
          items: [
            {
              id: "c1",
              text: "Write the methods section for both test types",
              category: "deliverable",
              page: 3,
              done: true,
            },
            {
              id: "c2",
              text: "Include the full software output as an appendix",
              category: "deliverable",
              page: 4,
              done: true,
            },
            {
              id: "c3",
              text: "State both hypotheses in symbols before any working",
              category: "rubric",
              page: 5,
              done: false,
            },
            {
              id: "c4",
              text: "Submit one PDF per team on Canvas",
              category: "submission_rule",
              page: 1,
              done: false,
            },
            {
              id: "c5",
              text: "Name the file Team07_ST2334_Report.pdf exactly",
              category: "submission_rule",
              page: 1,
              done: false,
            },
            {
              id: "c6",
              text: "Keep the report within 15 pages including charts",
              category: "submission_rule",
              page: 2,
              done: false,
            },
          ],
        },
      },
    },
    {
      taskKey: "ma2001_slides",
      annotated: false,
      starter: {
        type: "flashcards",
        content: {
          cards: [
            {
              front: "What is an eigenvector of a matrix A?",
              back: "A nonzero vector v such that Av = λv. The scalar λ is the eigenvalue.",
              page: 12,
            },
            {
              front: "How do you find the eigenvalues of A?",
              back: "Solve the characteristic equation det(A - λI) = 0 for λ.",
              page: 13,
            },
            {
              front: "What is the characteristic polynomial of a 2x2 matrix?",
              back: "λ^2 - (tr A)λ + det A.",
              page: 13,
            },
            {
              front: "If A has n distinct eigenvalues, what follows?",
              back: "A is diagonalisable: A = PDP^(-1) with D diagonal.",
              page: 16,
            },
            {
              front: "What stays the same under A = PDP^(-1)?",
              back: "The eigenvalues, the determinant and the trace all stay the same.",
              page: 17,
            },
          ],
          practice: [
            {
              question: "Find the eigenvalues of A = [[4, 1], [2, 3]].",
              answer:
                "Characteristic polynomial λ^2 - 7λ + 10 = (λ - 5)(λ - 2), so λ = 5 and λ = 2.",
              page: 17,
            },
            {
              question:
                "Show that v = (1, -1) is an eigenvector of A = [[2, 1], [1, 2]] and state its eigenvalue.",
              answer: "Av = (1, -1) = 1 times v, so the eigenvalue is λ = 1.",
              page: 18,
            },
            {
              question:
                "A has eigenvalues 5 and 2 with eigenvectors (1, 1) and (1, -2). Write A = PDP^(-1).",
              answer: "P has the eigenvectors as its columns and D = diag(5, 2).",
              page: 18,
            },
          ],
        },
      },
    },
    {
      taskKey: "math_chain_rule",
      annotated: true,
      starter: {
        type: "math_diagnosis",
        content: {
          steps: [
            {
              index: 1,
              latex_or_text: "u = 3x + 1, \\quad y = u^5",
              bbox: { x1: 100, y1: 110, x2: 520, y2: 190 },
            },
            {
              index: 2,
              latex_or_text: "\\frac{dy}{du} = 5u^4",
              bbox: { x1: 100, y1: 300, x2: 560, y2: 380 },
            },
            {
              index: 3,
              latex_or_text: "\\frac{dy}{dx} = 5(3x + 1)^4",
              bbox: { x1: 120, y1: 520, x2: 640, y2: 600 },
            },
            {
              index: 4,
              latex_or_text: "f'(1) = 5(4)^4 = 1280",
              bbox: { x1: 100, y1: 700, x2: 600, y2: 790 },
            },
          ],
          is_correct: false,
          first_error_step: 3,
          what_went_wrong:
            "The chain rule was applied halfway. $\\frac{dy}{du} = 5u^4$ is right, but the derivative of the inner function $u = 3x + 1$ was never multiplied in, so line 3 is missing the factor of 3.",
          misconception: {
            topic: "differentiation_chain_rule",
            detail: CHAIN_RULE_MISCONCEPTION,
          },
          correct_next_step:
            "Finish the chain rule: $\\frac{dy}{dx} = \\frac{dy}{du} \\cdot \\frac{du}{dx} = 5(3x + 1)^4 \\cdot 3 = 15(3x + 1)^4$.",
          final_answer_check:
            "The submitted answer 1280 does not stand. With the correct derivative, $f'(1) = 15(4)^4 = 3840$.",
          practice: CHAIN_RULE_PRACTICE,
        },
      },
    },
    {
      taskKey: "review_chain_rule",
      annotated: false,
      starter: {
        type: "review_practice",
        content: {
          topic: "differentiation_chain_rule",
          misconception: CHAIN_RULE_MISCONCEPTION,
          practice: CHAIN_RULE_PRACTICE,
        },
      },
    },
  ];

  const weakSpots: DemoWeakSpot[] = [
    {
      key: "chain_rule",
      topic: "differentiation_chain_rule",
      latestMisconception: CHAIN_RULE_MISCONCEPTION,
      occurrences: 3,
      lastSeenAt: createdAtSgt(now, -1),
      nextReviewAt: reviewDue,
    },
    {
      key: "fractions",
      topic: "fractions",
      latestMisconception:
        "Adds and compares fractions without a common denominator, so sizes and signs go wrong.",
      occurrences: 2,
      lastSeenAt: createdAtSgt(now, -6),
      nextReviewAt: dueAtSgt(now, -5),
    },
    {
      key: "sign_errors",
      topic: "sign_errors",
      latestMisconception:
        "Drops a minus sign when expanding brackets or moving terms across the equals sign.",
      occurrences: 1,
      lastSeenAt: createdAtSgt(now, -13),
      nextReviewAt: dueAtSgt(now, -10),
    },
  ];

  // Step 3 box on the 0-1000 grid, mapped to pixels of the 1200x900 canvas.
  const annotatedImage: DemoAnnotatedImage = {
    width: 1200,
    height: 900,
    ringBox: { left: 144, top: 468, width: 624, height: 72 },
  };

  return {
    displayName: opts.demoName ?? null,
    uploads,
    tasks,
    taskEvents,
    starters,
    weakSpots,
    annotatedImage,
  };
}

// ---------- argument parser (exported for tests) ----------

export type SeedScriptArgs = {
  // Without --yes the script is a dry run and writes nothing.
  apply: boolean;
  reset: boolean;
  telegramId: number;
  name: string | null;
};

export type ParsedSeedArgs =
  | { ok: true; args: SeedScriptArgs }
  | { ok: false; error: string };

export function parseSeedArgs(argv: string[], allowedIds: number[]): ParsedSeedArgs {
  let apply = false;
  let reset = false;
  let name: string | null = null;
  let idRaw: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes") {
      apply = true;
    } else if (arg === "--reset") {
      reset = true;
    } else if (arg === "--name") {
      const value = argv[i + 1];
      i += 1;
      if (value == null || value.trim() === "") {
        return { ok: false, error: "--name needs a value, e.g. --name Wei Lun" };
      }
      name = value.trim();
    } else if (arg === "--telegram-id") {
      const value = argv[i + 1];
      i += 1;
      if (value == null || value.trim() === "") {
        return {
          ok: false,
          error: "--telegram-id needs a value, e.g. --telegram-id 123456789",
        };
      }
      idRaw = value.trim();
    } else {
      return {
        ok: false,
        error: `Unknown argument: ${arg}. Supported: --telegram-id <id>, --name <first name>, --reset, --yes`,
      };
    }
  }

  if (allowedIds.length === 0) {
    return {
      ok: false,
      error:
        "ALLOWED_TELEGRAM_IDS is empty, so there is no safe default id. Add your id to ALLOWED_TELEGRAM_IDS in .env first.",
    };
  }

  let telegramId = allowedIds[0];
  if (idRaw != null) {
    const parsed = Number(idRaw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return {
        ok: false,
        error: `--telegram-id must be a positive whole number, got "${idRaw}".`,
      };
    }
    if (!allowedIds.includes(parsed)) {
      return {
        ok: false,
        error: `Telegram id ${parsed} is not in ALLOWED_TELEGRAM_IDS, so the seed refuses to touch it. Add the id to ALLOWED_TELEGRAM_IDS in .env first.`,
      };
    }
    telegramId = parsed;
  }

  return { ok: true, args: { apply, reset, telegramId, name } };
}

// ---------- dry run plan printer (exported for tests) ----------

// Only the Supabase project HOST is ever printed. Secrets passed in here must
// never reach the output, which the test asserts with obvious fake values.
export type PlanEnvLike = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY?: string;
  MODEL_API_KEY?: string;
};

function supabaseHostOf(envLike: PlanEnvLike): string {
  try {
    return new URL(envLike.SUPABASE_URL).host;
  } catch {
    return "(unknown host)";
  }
}

export function formatDryRunPlan(
  args: SeedScriptArgs,
  data: DemoData,
  envLike: PlanEnvLike
): string[] {
  const lines: string[] = [];
  lines.push("Dry run: nothing has been written. Run again with --yes to seed.");
  lines.push(`Target Telegram user: ${args.telegramId} (from ALLOWED_TELEGRAM_IDS)`);
  lines.push(`Supabase project: ${supabaseHostOf(envLike)} (key never shown)`);
  if (args.reset) {
    lines.push(
      "Would first delete this user's previous demo rows (tasks, task events, starters, demo uploads, demo weak spots), then reseed."
    );
  }
  lines.push("Would upsert 1 user");
  lines.push(`Would write ${data.uploads.length} uploads (tagged ${DEMO_UPLOAD_MARKER})`);
  lines.push(`Would write ${data.tasks.length} tasks`);
  lines.push(`Would write ${data.taskEvents.length} task events`);
  lines.push(`Would write ${data.starters.length} starters`);
  lines.push(`Would write ${data.weakSpots.length} weak spots`);
  lines.push("Would upload 2 images to Storage (original math photo and the annotated copy)");
  lines.push("Next step after seeding: send /dashboard to the bot to open it.");
  return lines;
}
