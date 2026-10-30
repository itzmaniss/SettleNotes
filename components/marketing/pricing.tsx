import {
  PLANS,
  PLAN_ORDER,
  formatPrice,
  yearlyPerMonth,
  yearlySavingsPercent,
  type PlanId,
} from "@/lib/billing/plans";
import { isBillingEnabled } from "@/lib/billing/flags";
import { botLink } from "./links";
import { PricingSection, type PricingCardData } from "./pricing-section";

// The single place where plans.ts meets JSX: every string a visitor sees is
// derived here and handed to the client component as plain data.
export function buildPricingCards(): PricingCardData[] {
  return PLAN_ORDER.map((id: PlanId) => {
    const plan = PLANS[id];
    return {
      id,
      name: plan.name,
      priceMonthly: formatPrice(plan.price.monthly, plan.price.currency),
      priceYearly: formatPrice(plan.price.yearly, plan.price.currency),
      yearlyPerMonth:
        plan.price.yearly > 0
          ? formatPrice(yearlyPerMonth(id), plan.price.currency)
          : null,
      anchor: plan.price.anchor,
      bullets: plan.bullets,
    };
  });
}

export function Pricing() {
  return (
    <section
      id="pricing"
      className="mx-auto max-w-6xl scroll-mt-4 px-4 py-12 sm:px-6 md:py-16"
    >
      <PricingSection
        cards={buildPricingCards()}
        billingEnabled={isBillingEnabled()}
        botHref={botLink()}
        yearlySavePercent={yearlySavingsPercent("pro")}
        heading={
          <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
            Free to start.
            <br />
            Pro when it&apos;s crunch time.
          </h2>
        }
      />
    </section>
  );
}
