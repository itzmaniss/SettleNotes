// Token filling for the legal pages. Pure: no process.env, no fs. The pages
// load it with the parsed env injected (lib/legal/content.ts) and the check
// script and the tests build the same map, so the flag dependent wording
// lives in exactly one place.
import { PLANS, formatPrice } from "@/lib/billing/plans";
import { isCalendarSyncEnabled } from "@/lib/calendar/flags";

export const LEGAL_TOKEN_NAMES = [
  "effective_date",
  "business_name",
  "business_uen",
  "support_email",
  "supabase_region",
  "price_pro_monthly",
  "price_pro_yearly",
  "stars_monthly",
  "web_cancel_sentence",
  "stripe_refund_sentence",
  "stripe_role_sentence",
  "calendar_section",
] as const;

export type LegalTokenName = (typeof LEGAL_TOKEN_NAMES)[number];

export type LegalTokens = Record<LegalTokenName, string>;

// The slice of lib/env the filler needs. Field names match the parsed env
// exactly, so getEnv() can be passed as is and tests can pass a hand made
// object instead.
export type LegalTokenEnv = {
  LEGAL_BUSINESS_NAME?: string | undefined;
  LEGAL_SUPPORT_EMAIL?: string | undefined;
  LEGAL_SUPABASE_REGION?: string | undefined;
  LEGAL_BUSINESS_UEN?: string | undefined;
  STRIPE_MANAGED_PAYMENTS?: boolean | undefined;
  // Google Calendar sync switch. Only the flag shape matters here; a blank
  // or missing value reads as off, the same rule isCalendarSyncEnabled uses.
  // The loader fills these from the parsed env, tests pass them by hand.
  CALENDAR_SYNC_ENABLED?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  CALENDAR_TOKEN_KEY?: string | undefined;
  CALENDAR_CRON_SECRET?: string | undefined;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// '2026-11-01' becomes '1 November 2026', built by hand so no locale decides
// the wording. An unreadable version comes back unchanged rather than wrong.
export function formatLegalDate(version: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
  if (match === null) return version;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return version;
  return `${Number(match[3])} ${MONTHS[month - 1]} ${match[1]}`;
}

// A blank value counts as absent, same rule as lib/env normalize, and becomes
// a visible marker naming the variable so the check script catches it.
function given(raw: string | undefined, variable: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : `[[MISSING: ${variable}]]`;
}

// The Google Calendar notice, shown only while the sync feature is on.
// Plain paragraphs only, no lists or markers, so the check script sees
// clean text in both states. The heading is unnumbered on purpose: the
// numbered sections keep their numbers in both states.
// Not managed by counsel yet: recommend a version bump and lawyer review
// before switching the feature on.
export const CALENDAR_SECTION_TEXT = [
  "## Google Calendar (Pro)",
  "",
  "If you are on Pro and you connect Google Calendar, Settle puts your task titles, course names and deadlines into a separate calendar called Settle in your own Google account.",
  "",
  "Settle can reach only that calendar. Settle cannot see or change the rest of your Google Calendar.",
  "",
  "Settle keeps a connection record and an encrypted key that lets Settle keep the Settle calendar up to date, and a list that links your tasks to calendar events. Settle keeps these until you disconnect or delete your account.",
  "",
  "To stop, open the Account page and choose Disconnect. That removes the Settle calendar, ends Settle access at Google and removes the records. Deleting your account does the same. You can also remove Settle access any time in your Google account settings.",
  "",
  "Google is an additional service provider only for people who connect it. Settle uses Google data only to show your deadlines in your calendar. Settle does not sell it, does not use it for advertising and does not let people read it except where the law requires.",
  "",
  "Settle's use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
  "",
  "While you connect, Settle uses one short lived sign in cookie that is strictly necessary to finish the sign in. It lasts ten minutes and is gone after that.",
].join("\n");

export function legalTokens(input: { env: LegalTokenEnv; version: string }): LegalTokens {
  const { env } = input;
  // Same boolean convention as lib/billing/stripe.ts managedPaymentsEnabled.
  const managed = env.STRIPE_MANAGED_PAYMENTS === true;
  const calendarOn = isCalendarSyncEnabled({
    CALENDAR_SYNC_ENABLED: env.CALENDAR_SYNC_ENABLED,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    CALENDAR_TOKEN_KEY: env.CALENDAR_TOKEN_KEY,
    CALENDAR_CRON_SECRET: env.CALENDAR_CRON_SECRET,
  });
  const stars = PLANS.pro.price.stars;
  return {
    effective_date: formatLegalDate(input.version),
    business_name: given(env.LEGAL_BUSINESS_NAME, "LEGAL_BUSINESS_NAME"),
    business_uen: given(env.LEGAL_BUSINESS_UEN, "LEGAL_BUSINESS_UEN"),
    support_email: given(env.LEGAL_SUPPORT_EMAIL, "LEGAL_SUPPORT_EMAIL"),
    supabase_region: given(env.LEGAL_SUPABASE_REGION, "LEGAL_SUPABASE_REGION"),
    price_pro_monthly: formatPrice(PLANS.pro.price.monthly, PLANS.pro.price.currency),
    price_pro_yearly: formatPrice(PLANS.pro.price.yearly, PLANS.pro.price.currency),
    stars_monthly: stars == null ? "[[MISSING: PRO STARS PRICE]]" : String(stars.monthly),
    web_cancel_sentence: managed
      ? "You can cancel a web subscription from the billing page in the dashboard, which opens Stripe's customer portal, or on Link's website (link.com)."
      : "You can cancel a web subscription from the billing page in the dashboard, which opens Stripe's customer portal.",
    stripe_refund_sentence: managed
      ? "Because Stripe is the seller of record for web payments, Stripe may also issue a refund itself within 60 days in some cases, and its support team handles payment questions through Link."
      : "Refunds for web payments are issued by Settle through Stripe.",
    stripe_role_sentence: managed
      ? "Stripe, through its Link service, is the seller of record for web card subscriptions. It collects your payment details and billing address, handles tax and payment support, and shares with Settle only what Settle needs to manage your subscription."
      : "Stripe receives your payment details. Settle receives only what it needs to manage your subscription.",
    // Intentionally empty while the feature is off. Empty is a real value
    // here, not a missing one: it must never become a [[MISSING]] marker.
    calendar_section: calendarOn ? CALENDAR_SECTION_TEXT : "",
  };
}

// Replaces every {{name}} with its value. A name that is not in the map stays
// visible as [[UNKNOWN TOKEN: name]] so a typo can never ship silently, and
// accidental double spaces (usually left behind by a removed token) collapse
// to one. A token line left empty (calendar_section while the feature is off)
// leaves a blank line behind, so runs of three or more newlines collapse to
// two: the off state reads exactly as if the token line were not there.
// Everything else is untouched.
export function fillTokens(source: string, tokens: Record<string, string>): string {
  const filled = source.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_whole, name: string) =>
    Object.prototype.hasOwnProperty.call(tokens, name)
      ? tokens[name]
      : `[[UNKNOWN TOKEN: ${name}]]`,
  );
  return filled.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n");
}
