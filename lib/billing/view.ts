// Pure view-model for the /billing page: everything the page shows is derived
// here from plans.ts and the stored subscription rows, so the page component
// only renders. Copy lives in exported constants so wording changes happen in
// one place. No Stripe, env or db imports.
import { PLANS, formatPrice, yearlySavingsPercent, type Feature, type PlanId } from "./plans";
import { PURCHASE_CONFIRM_FAILED, PURCHASE_CONFIRM_WEB_ERROR } from "./purchase-consent-copy";
import type { PlanView } from "@/lib/dashboard/plan";
import { buildPlanView } from "@/lib/dashboard/plan";
import { isTestModeKey, managedPaymentsEnabled, stripeConfigured, type StripeEnvConfig } from "./stripe";
// The Stars cancel steps live in the client safe account copy leaf so the
// account deletion banner and the billing page quote one set of steps.
import { STARS_CANCEL_STEPS } from "@/lib/account/web-copy";
import { MANAGED_PORTAL_LINE } from "./web-copy";

// ---- Copy (plain, friendly, no dashes) --------------------------------------

export const CLOSED_NOTE = "Paid plans are not open yet.";
export const PREFER_TELEGRAM_LINE =
  "Prefer Telegram? You can also subscribe with Stars from the bot.";
export const STARS_ACTIVE_LINE =
  `Your plan runs through Telegram. To cancel, ${STARS_CANCEL_STEPS}.`;
export const PAYNOW_LABEL = "Pay once with PayNow for a year";
// The portal button is the only change path for a Stripe subscription, so the
// label says what it is for and the lines under it say what it does, in one
// plain sentence each. All three are true in code: openPortalFor opens a
// Stripe customer portal for cancel and update, cancelling keeps Pro until
// the paid period ends (the refund policy sentence), and the app has no
// interval switch of its own for an active subscription.
export const MANAGE_BUTTON_LABEL = "Manage or cancel your plan";
export const PORTAL_PURPOSE_LINE =
  "This button opens Stripe's customer portal, where you can change or cancel your plan.";
export const PORTAL_KEEP_PRO_LINE =
  "If you cancel, you keep Pro until the end of the period you already paid for.";
export const PORTAL_SWITCH_LINE =
  "Moving between monthly and yearly is done in the portal too.";
export const TEST_MODE_STICKER = "Test mode, no real charges";
export { WEB_NUDGE_LINE, MANAGED_PORTAL_LINE } from "./web-copy";

export const SUCCESS_BANNER =
  "Thanks! Your plan switches on in a few seconds. Refresh if you do not see Pro yet.";
export const CANCELED_BANNER = "No worries, nothing was charged.";
export const ERROR_BANNER =
  "Something went wrong on my side. Please try again in a moment.";
// Calm refusal when a stale PayNow request lands while Managed Payments is on.
export const PAYNOW_UNAVAILABLE_LINE =
  "PayNow is not available right now. You can pay monthly or yearly with a card, or use Stars in the bot.";

// Confirm gate banners: the tick is missing, or the tap could not be saved.
// Both copy strings come from the client safe purchase-consent-copy leaf.
export const CONFIRM_NEEDED_BANNER = PURCHASE_CONFIRM_WEB_ERROR;
export const CONFIRM_FAILED_BANNER = PURCHASE_CONFIRM_FAILED;

export const MONTHLY_LABEL = "Monthly";
export const YEARLY_LABEL = "Yearly";

// ---- The closed billing line ---------------------------------------------------

// Student words for each feature id in plans.ts.
const FREE_FEATURE_WORDS: Record<Feature, string> = {
  chat_capture: "chat capture",
  math_diagnosis: "maths checks",
  slides_flashcards: "slide decks",
  brief_checklist: "briefs",
  weak_spot_tracker: "the weak spot tracker",
};

// 'a, b and c' with no Oxford comma, matching the lock banner wording.
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

// The one honest line under the closed note: what Free already covers, with
// the limited features read straight from the plans.ts free quotas, so the
// words can never drift from the numbers the usage gate enforces.
export function freeCoverLine(): string {
  const limited = (Object.keys(PLANS.free.quotas) as Feature[])
    .filter((key) => typeof PLANS.free.quotas[key] === "number")
    .map((key) => FREE_FEATURE_WORDS[key]);
  if (limited.length === 0) return "Free covers chat capture and deadline tracking.";
  return `Free covers chat capture and deadline tracking, with monthly limits on ${joinNames(limited)}.`;
}

// ---- Checkout options (prices only ever from plans.ts) ------------------------

export type BillingOptionView = {
  interval: "monthly" | "yearly";
  label: string;
  price: string;
  note: string | null;
};

export function billingOptions(): BillingOptionView[] {
  const pro = PLANS.pro.price;
  const saving = yearlySavingsPercent("pro");
  return [
    {
      interval: "monthly",
      label: MONTHLY_LABEL,
      price: formatPrice(pro.monthly, pro.currency),
      note: null,
    },
    {
      interval: "yearly",
      label: YEARLY_LABEL,
      price: formatPrice(pro.yearly, pro.currency),
      note: saving > 0 ? `Save ${saving} percent with the yearly plan` : null,
    },
  ];
}

// ---- Status banners -----------------------------------------------------------

export type BillingBanner = { tone: "success" | "neutral" | "error"; message: string };

export function statusBanner(status: string | undefined | null): BillingBanner | null {
  switch (status) {
    case "success":
      return { tone: "success", message: SUCCESS_BANNER };
    case "canceled":
      return { tone: "neutral", message: CANCELED_BANNER };
    case "error":
      return { tone: "error", message: ERROR_BANNER };
    case "paynow_unavailable":
      return { tone: "neutral", message: PAYNOW_UNAVAILABLE_LINE };
    case "confirm_needed":
      return { tone: "error", message: CONFIRM_NEEDED_BANNER };
    case "confirm_failed":
      return { tone: "error", message: CONFIRM_FAILED_BANNER };
    default:
      return null;
  }
}

// ---- Current plan block ---------------------------------------------------------

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// '30 Nov' in Singapore wall clock, matching the plan card's reset wording.
function formatDayMonth(date: Date): string {
  const shifted = new Date(date.getTime() + SGT_OFFSET_MS);
  return `${shifted.getUTCDate()} ${MONTH_SHORT[shifted.getUTCMonth()]}`;
}

export type CurrentPlanView = {
  planName: string;
  // 'Pro until 30 Nov' when an active subscription carries an end date.
  until: string | null;
  usage: PlanView;
};

export function buildCurrentPlan(args: {
  plan: PlanId;
  periodEnd: string | null;
  usage: Partial<Record<"math_diagnosis" | "slides_flashcards" | "brief_checklist", number>>;
  now: Date;
}): CurrentPlanView {
  const until =
    args.plan === "pro" && args.periodEnd !== null ? formatDayMonth(new Date(args.periodEnd)) : null;
  return {
    planName: PLANS[args.plan].name,
    until,
    usage: buildPlanView({ plan: args.plan, usage: args.usage, now: args.now }),
  };
}

// ---- Whole-page view -------------------------------------------------------------

export type BillingPageView = {
  current: CurrentPlanView;
  // Billing on and Stripe configured: pay options may render.
  open: boolean;
  // False whenever Managed Payments is on: Stripe picks the payment methods
  // and PayNow is not among them, so the one time PayNow year disappears.
  paynowAvailable: boolean;
  // Active Stripe subscription with a real subscription ref: portal button.
  showPortal: boolean;
  // link.com note under the portal button, only while Managed Payments is on.
  portalNote: string | null;
  starsActive: boolean;
  testMode: boolean;
  banner: BillingBanner | null;
  options: BillingOptionView[];
};

export function buildBillingPageView(args: {
  plan: PlanId;
  periodEnd: string | null;
  usage: Partial<Record<"math_diagnosis" | "slides_flashcards" | "brief_checklist", number>>;
  now: Date;
  billingEnabled: boolean;
  env: StripeEnvConfig;
  activeStripeRef: string | null;
  starsActive: boolean;
  status: string | undefined | null;
}): BillingPageView {
  const open = args.billingEnabled && stripeConfigured(args.env);
  const managedPayments = managedPaymentsEnabled(args.env);
  // Managed Payments puts Stripe in charge of payment methods, so PayNow
  // cannot be offered and its price env var is ignored (docs/STRIPE-MANAGED-PAYMENTS.md).
  const paynowAvailable =
    open &&
    !managedPayments &&
    typeof args.env.STRIPE_PRICE_PRO_YEARLY_PAYNOW === "string" &&
    args.env.STRIPE_PRICE_PRO_YEARLY_PAYNOW.length > 0;
  const showPortal = args.activeStripeRef !== null && args.activeStripeRef.startsWith("sub_");
  return {
    current: buildCurrentPlan({
      plan: args.plan,
      periodEnd: args.periodEnd,
      usage: args.usage,
      now: args.now,
    }),
    open,
    paynowAvailable,
    // A paynow:<session> ref is not a subscription, so no portal for it.
    showPortal,
    // link.com also manages Managed Payments subscriptions; keep the note to
    // one plain sentence so the portal button itself stays unchanged.
    portalNote: showPortal && managedPayments ? MANAGED_PORTAL_LINE : null,
    starsActive: args.starsActive,
    testMode: isTestModeKey(args.env.STRIPE_SECRET_KEY),
    banner: statusBanner(args.status),
    options: billingOptions(),
  };
}
