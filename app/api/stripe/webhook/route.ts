import { env } from "@/lib/env";
import {
  handleStripeEvent,
  processStripeWebhook,
} from "@/lib/billing/stripe";
import { getStripe } from "@/lib/billing/stripe-client";
import {
  deleteBillingEvent,
  findBillingEvent,
  recordBillingEvent,
  upsertSubscription,
} from "@/lib/billing/subscriptions";

export const runtime = "nodejs";

// Thin wrapper only: raw body + signature in, status out. All logic lives in
// lib/billing/stripe.ts. Not in the session middleware matcher on purpose.
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  const result = await processStripeWebhook({
    rawBody,
    signature,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    verify: (raw, sig, secret) => getStripe().webhooks.constructEvent(raw, sig, secret),
    handle: (event) =>
      handleStripeEvent(
        {
          findBillingEvent,
          recordBillingEvent,
          deleteBillingEvent,
          upsertSubscription,
          retrieveSubscription: (id) => getStripe().subscriptions.retrieve(id),
        },
        event as Parameters<typeof handleStripeEvent>[1],
      ),
  });
  return new Response(result.body, {
    status: result.status,
    headers:
      result.status === 200 ? { "content-type": "application/json" } : { "content-type": "text/plain" },
  });
}
