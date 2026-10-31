// One place for the out-of-quota wording, so the user can edit it here and
// nowhere else. The bot states the limit and points to /dashboard. It never
// sells inside Telegram: no price, no buy or upgrade wording, no links (the
// app stores enforce this). Month name and reset date come from resetsAt in
// Asia/Singapore, the limit from the args: nothing is hardcoded.
import type { Feature } from "./plans";

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Free plan wording: {limit} free {feature} for {month}.
export const QUOTA_REPLY_TEMPLATE =
  "You've used your {limit} free {feature} for {month}. They reset on {resetDate}. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan.";

// Pro fair-use cap wording: the monthly limit of {limit} {feature}.
export const FAIR_USE_REPLY_TEMPLATE =
  "You've reached the monthly limit of {limit} {feature}. They reset on {resetDate}. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan.";

const FEATURE_NOUNS: Record<Feature, { singular: string; plural: string }> = {
  chat_capture: { singular: "chat capture", plural: "chat captures" },
  math_diagnosis: { singular: "math check", plural: "math checks" },
  slides_flashcards: { singular: "slide deck", plural: "slide decks" },
  brief_checklist: { singular: "brief checklist", plural: "brief checklists" },
  weak_spot_tracker: { singular: "weak spot review", plural: "weak spot reviews" },
};

const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type QuotaReplyArgs = {
  feature: Feature;
  limit: number;
  resetsAt: Date;
  reason: "quota" | "fair_use";
  now?: Date;
};

export function quotaHitReply(args: QuotaReplyArgs): string {
  // The usage month is the one that ends at resetsAt, so read it one day back
  // when now is not given. Both reads are SGT wall clock via the +8 shift.
  const monthRef = args.now ?? new Date(args.resetsAt.getTime() - DAY_MS);
  const month = FULL_MONTHS[new Date(monthRef.getTime() + SGT_OFFSET_MS).getUTCMonth()];
  const resetShifted = new Date(args.resetsAt.getTime() + SGT_OFFSET_MS);
  const resetDate = `${resetShifted.getUTCDate()} ${SHORT_MONTHS[resetShifted.getUTCMonth()]}`;
  const noun =
    args.limit === 1 ? FEATURE_NOUNS[args.feature].singular : FEATURE_NOUNS[args.feature].plural;
  const template = args.reason === "fair_use" ? FAIR_USE_REPLY_TEMPLATE : QUOTA_REPLY_TEMPLATE;
  return template
    .replace("{limit}", String(args.limit))
    .replace("{feature}", noun)
    .replace("{month}", month)
    .replace("{resetDate}", resetDate);
}
