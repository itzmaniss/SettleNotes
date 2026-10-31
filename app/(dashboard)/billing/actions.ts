"use server";

import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth/session";
import { isBillingEnabled } from "@/lib/billing/flags";
import { getLatestSubscription } from "@/lib/billing/subscriptions";
import { openPortalFor, startCheckoutFor } from "@/lib/billing/stripe";
import { getStripe } from "@/lib/billing/stripe-client";
import { env } from "@/lib/env";

// Thin server actions: the interval is the only untrusted input and is
// schema checked inside startCheckoutFor; the user id always comes from the
// signed session, never from the form. Each action ends in exactly one
// redirect, so nothing here returns data.
export async function startCheckout(formData: FormData): Promise<void> {
  const url = await startCheckoutFor(formData.get("interval"), {
    sessionUserId: async () => (await requireSessionUser()).userId,
    billingEnabled: isBillingEnabled,
    env: () => env,
    baseUrl: () => env.APP_BASE_URL,
    createSession: (params) => getStripe().checkout.sessions.create(params),
  });
  redirect(url);
}

export async function openPortal(): Promise<void> {
  const { userId } = await requireSessionUser();
  const url = await openPortalFor({
    sessionUserId: async () => userId,
    baseUrl: () => env.APP_BASE_URL,
    latestStripeRef: async () => (await getLatestSubscription(userId, "stripe"))?.provider_ref ?? null,
    retrieveSubscription: (id) => getStripe().subscriptions.retrieve(id),
    createPortalSession: (params) => getStripe().billingPortal.sessions.create(params),
  });
  redirect(url);
}
