import type { Metadata } from "next";
import { requireSessionUser } from "@/lib/auth/session";
import { isBillingEnabled } from "@/lib/billing/flags";
import { getPlanForUser, periodStart } from "@/lib/billing/entitlements";
import { getActiveSubscription, countUsage } from "@/lib/billing/queries";
import { getLatestSubscription } from "@/lib/billing/subscriptions";
import { env } from "@/lib/env";
import { buildBillingPageView } from "@/lib/billing/view";
import { BillingPanel } from "@/components/billing/billing-panel";
import { LegalLinks } from "@/components/legal/legal-links";
import { openPortal, startCheckout } from "./actions";

export const metadata: Metadata = {
  title: "Plan and billing",
};

type SearchParams = { status?: string | string[] };

function firstStatus(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Server half of /billing: loads the plan, the usage ledger and the stored
// subscription rows, then hands plain data to the panel. The page itself is
// protected twice: middleware redirects signed-out visitors, and
// requireSessionUser fails closed for the data reads.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { userId } = await requireSessionUser();
  const params = await searchParams;
  const now = new Date();

  const billingEnabled = isBillingEnabled();
  let plan: "free" | "pro" = billingEnabled ? "free" : "pro";
  let periodEnd: string | null = null;
  let activeProvider: string | null = null;
  let usage: Partial<
    Record<"math_diagnosis" | "slides_flashcards" | "brief_checklist", number>
  > = {};
  try {
    plan = billingEnabled ? await getPlanForUser(userId) : "pro";
    const active = await getActiveSubscription(userId, now);
    periodEnd = active?.current_period_end ?? null;
    activeProvider = active?.provider ?? null;
    if (plan === "free") {
      const period = periodStart(now);
      const [mathUsed, decksUsed, briefsUsed] = await Promise.all([
        countUsage({ userId, feature: "math_diagnosis", periodStart: period }),
        countUsage({ userId, feature: "slides_flashcards", periodStart: period }),
        countUsage({ userId, feature: "brief_checklist", periodStart: period }),
      ]);
      usage = {
        math_diagnosis: mathUsed,
        slides_flashcards: decksUsed,
        brief_checklist: briefsUsed,
      };
    }
  } catch {
    // A missing or broken ledger must never take the whole page down; the
    // plan block just renders with zeros and the default plan.
  }

  const [stripeRow, status] = await Promise.all([
    getLatestSubscription(userId, "stripe").catch(() => null),
    Promise.resolve(firstStatus(params.status)),
  ]);

  const view = buildBillingPageView({
    plan,
    periodEnd,
    usage,
    now,
    billingEnabled,
    env,
    activeStripeRef: stripeRow?.provider_ref ?? null,
    // Only a live Stars subscription claims the Telegram manage line.
    starsActive: activeProvider === "stars",
    status,
  });

  return (
    <>
      <BillingPanel view={view} startCheckout={startCheckout} openPortal={openPortal} />
      <footer className="mx-auto w-full max-w-2xl px-4 pb-12">
        <LegalLinks />
      </footer>
    </>
  );
}
