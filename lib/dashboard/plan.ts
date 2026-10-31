// Plan card view-model: pure, unit tested in tests/dashboard/plan.test.tsx.
// Limits come from the billing seams (limitFor) and the reset date from
// nextPeriodStart, so the card can never drift from what the gate enforces.
// Fair-use caps stay off the card: they are enforcement details, not
// something to advertise.
import { limitFor, nextPeriodStart } from "@/lib/billing/entitlements";
import { PLANS, type Feature, type PlanId } from "@/lib/billing/plans";

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const METERED_ROWS: Array<{ feature: MeteredFeature; label: string }> = [
  { feature: "math_diagnosis", label: "Math checks" },
  { feature: "slides_flashcards", label: "Slide decks" },
  { feature: "brief_checklist", label: "Briefs to checklist" },
];

export type MeteredFeature = Extract<
  Feature,
  "math_diagnosis" | "slides_flashcards" | "brief_checklist"
>;

export type PlanUsageRow = {
  feature: MeteredFeature;
  label: string;
  used: number;
  // A number is a hard monthly quota; "unlimited" covers both the unlimited
  // and the fair-use kinds so the caps never show up as marketing numbers.
  limit: number | "unlimited";
  resetsOn: string;
};

export type PlanView = {
  planName: string;
  resetsOn: string;
  rows: PlanUsageRow[];
};

export type PlanViewArgs = {
  plan: PlanId;
  usage: Partial<Record<Feature, number>>;
  now: Date;
};

// '1 Nov' in Singapore wall clock, matching the bot's reset wording.
function formatResetDate(date: Date): string {
  const shifted = new Date(date.getTime() + SGT_OFFSET_MS);
  return `${shifted.getUTCDate()} ${MONTH_SHORT[shifted.getUTCMonth()]}`;
}

export function buildPlanView(args: PlanViewArgs): PlanView {
  const resetsOn = formatResetDate(nextPeriodStart(args.now));
  const rows: PlanUsageRow[] = METERED_ROWS.map(({ feature, label }) => {
    const { limit, kind } = limitFor(args.plan, feature);
    return {
      feature,
      label,
      used: args.usage[feature] ?? 0,
      limit: kind === "quota" && limit != null ? limit : "unlimited",
      resetsOn,
    };
  });
  return { planName: PLANS[args.plan].name, resetsOn, rows };
}

// '2 of 3' for a capped row, '2 used' when unlimited.
export function usageLine(row: PlanUsageRow): string {
  if (row.limit === "unlimited") return `${row.used} used`;
  return `${row.used} of ${row.limit}`;
}

// Plain feature names for the lock banner sentence. Kept out of METERED_ROWS
// so buildPlanView's row shape (unit tested with toEqual) never changes.
const LOCK_FEATURE_NAMES: Record<MeteredFeature, string> = {
  math_diagnosis: "math checks",
  slides_flashcards: "slide decks",
  brief_checklist: "brief checklists",
};

export type LockState = {
  /** Plain names of every metered feature whose limit is used up. */
  features: string[];
  resetsOn: string;
  /** The whole banner sentence, human wording, no numbers beyond the date. */
  sentence: string;
};

// Pure: which metered features a Free plan has used up this month and when
// they come back. Null when nothing is exhausted, so callers render nothing.
// Unlimited rows (any Pro plan) can never be exhausted by construction.
export function lockState(view: PlanView): LockState | null {
  const exhausted = view.rows.filter(
    (row) => row.limit !== "unlimited" && row.used >= row.limit,
  );
  if (exhausted.length === 0) return null;
  const features = exhausted.map((row) => LOCK_FEATURE_NAMES[row.feature]);
  const names =
    features.length === 1
      ? features[0]!
      : `${features.slice(0, -1).join(", ")} and ${features[features.length - 1]!}`;
  return {
    features,
    resetsOn: view.resetsOn,
    sentence: `You have used all your free ${names} this month. They reset on ${view.resetsOn}.`,
  };
}
