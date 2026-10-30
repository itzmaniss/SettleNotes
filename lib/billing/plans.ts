// Single source of truth for plan names, prices, quotas and pricing bullets.
// Pure config: no imports from lib/env or lib/db. The landing page, the bot
// and the usage gate all read from here.
export type PlanId = "free" | "pro";

export type Feature =
  | "chat_capture"
  | "math_diagnosis"
  | "slides_flashcards"
  | "brief_checklist"
  | "weak_spot_tracker";

export type Plan = {
  name: string;
  price: {
    monthly: number;
    yearly: number;
    currency: "SGD" | "USD";
    stars: { monthly: number } | null;
    anchor: string | null;
  };
  quotas: Record<Feature, number | "unlimited" | "off">;
  fairUse: Partial<Record<Feature, number>>;
  bullets: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    name: "Free",
    price: { monthly: 0, yearly: 0, currency: "SGD", stars: null, anchor: null },
    quotas: {
      chat_capture: "unlimited",
      math_diagnosis: 3,
      slides_flashcards: 1,
      brief_checklist: 1,
      weak_spot_tracker: "unlimited",
    },
    fairUse: {},
    bullets: [
      "Unlimited chat forwards and deadline tracking",
      "3 math diagnoses a month",
      "1 slide deck to flashcards a month",
      "1 assignment brief to checklist a month",
      "Weak-spot tracker with spaced reviews",
    ],
  },
  pro: {
    name: "Pro",
    price: {
      monthly: 7.99,
      yearly: 63.99,
      currency: "SGD",
      stars: null,
      anchor: "Less than a McSpicy meal.",
    },
    quotas: {
      chat_capture: "unlimited",
      math_diagnosis: "unlimited",
      slides_flashcards: "unlimited",
      brief_checklist: "unlimited",
      weak_spot_tracker: "unlimited",
    },
    fairUse: { math_diagnosis: 300, slides_flashcards: 60, brief_checklist: 60 },
    bullets: [
      "Everything in Free",
      "Unlimited math diagnoses",
      "Unlimited briefs, slides and PDFs",
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "pro"];

export function formatPrice(amount: number, currency: "SGD" | "USD"): string {
  const prefix = currency === "SGD" ? "S$" : "US$";
  return `${prefix}${Number.isInteger(amount) ? String(amount) : amount.toFixed(2)}`;
}

export function yearlyPerMonth(plan: PlanId): number {
  return Math.round((PLANS[plan].price.yearly / 12) * 100) / 100;
}

export function yearlySavingsPercent(plan: PlanId): number {
  const { monthly, yearly } = PLANS[plan].price;
  if (monthly <= 0 || yearly <= 0) return 0;
  const full = monthly * 12;
  return Math.round(((full - yearly) / full) * 100);
}
