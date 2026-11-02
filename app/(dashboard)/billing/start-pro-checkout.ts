// The confirm gate and checkout flow for /billing, split out of actions.ts so
// tests can run it on injected fakes instead of mocking global modules. The
// userId always comes from the action's session and terms re-check; the
// confirm field is the payment time representation (18 or older, or a parent
// or guardian agreed) and applies to every paid checkout, PayNow included.
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { isBillingEnabled } from "@/lib/billing/flags";
import { recordPurchaseConfirmation } from "@/lib/billing/purchase-consent";
import { startCheckoutFor, type StripeEnvConfig } from "@/lib/billing/stripe";
import { getStripe } from "@/lib/billing/stripe-client";
import { getSupabase } from "@/lib/db/client";
import { env } from "@/lib/env";

export type CheckoutStartOutcome =
  // The form arrived without the tick: nothing written, nothing created.
  | { kind: "missing_confirm" }
  // The tap could not be saved: no checkout session may start.
  | { kind: "confirm_failed" }
  // The Stripe (or refusal) URL startCheckoutFor decided on.
  | { kind: "checkout"; url: string };

export type ProCheckoutDeps = {
  client: SupabaseClient;
  billingEnabled: () => boolean;
  envConfig: StripeEnvConfig;
  baseUrl: () => string;
  createSession: (
    params: Stripe.Checkout.SessionCreateParams,
  ) => Promise<{ url: string | null }>;
};

export function realProCheckoutDeps(): ProCheckoutDeps {
  return {
    client: getSupabase(),
    billingEnabled: isBillingEnabled,
    envConfig: env,
    baseUrl: () => env.APP_BASE_URL,
    createSession: (params) => getStripe().checkout.sessions.create(params),
  };
}

export async function startProCheckout(
  userId: string,
  formData: FormData,
  deps: ProCheckoutDeps,
): Promise<CheckoutStartOutcome> {
  if (formData.get("confirm") !== "on") {
    return { kind: "missing_confirm" };
  }
  const saved = await recordPurchaseConfirmation(deps.client, { userId, channel: "web" });
  if (!saved.ok) {
    return { kind: "confirm_failed" };
  }
  const url = await startCheckoutFor(formData.get("interval"), {
    sessionUserId: async () => userId,
    billingEnabled: deps.billingEnabled,
    env: () => deps.envConfig,
    baseUrl: deps.baseUrl,
    createSession: deps.createSession,
  });
  return { kind: "checkout", url };
}
