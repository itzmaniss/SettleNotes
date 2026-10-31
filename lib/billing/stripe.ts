// Stripe billing logic for the web dashboard, in the same split as
// lib/billing/stars.ts: pure mapping and params builders on top, webhook
// handling and action cores below with every dependency injected, so tests
// run on fakes and app/(dashboard)/billing plus the webhook route stay thin.
// No env, db or SDK imports here; the SDK client lives in stripe-client.ts.
import { z } from "zod";
import type Stripe from "stripe";

// ---- Config ----------------------------------------------------------------

// The slice of lib/env this module needs. Field names match the parsed env
// exactly, so getEnv() can be passed as is.
export type StripeEnvConfig = {
  STRIPE_SECRET_KEY?: string | undefined;
  STRIPE_WEBHOOK_SECRET?: string | undefined;
  STRIPE_PRICE_PRO_MONTHLY?: string | undefined;
  STRIPE_PRICE_PRO_YEARLY?: string | undefined;
  STRIPE_PRICE_PRO_YEARLY_PAYNOW?: string | undefined;
};

export type BillingInterval = "monthly" | "yearly";

// Ready to sell: both recurring prices must exist or one checkout option
// would 500 at click time. The PayNow one-time price is optional on purpose,
// so a deploy without it just hides that one option.
export function stripeConfigured(env: StripeEnvConfig): boolean {
  return (
    typeof env.STRIPE_SECRET_KEY === "string" &&
    env.STRIPE_SECRET_KEY.length > 0 &&
    typeof env.STRIPE_WEBHOOK_SECRET === "string" &&
    env.STRIPE_WEBHOOK_SECRET.length > 0 &&
    typeof env.STRIPE_PRICE_PRO_MONTHLY === "string" &&
    env.STRIPE_PRICE_PRO_MONTHLY.length > 0 &&
    typeof env.STRIPE_PRICE_PRO_YEARLY === "string" &&
    env.STRIPE_PRICE_PRO_YEARLY.length > 0
  );
}

export function priceIdFor(interval: BillingInterval, env: StripeEnvConfig): string | null {
  const priceId = interval === "monthly" ? env.STRIPE_PRICE_PRO_MONTHLY : env.STRIPE_PRICE_PRO_YEARLY;
  return typeof priceId === "string" && priceId.length > 0 ? priceId : null;
}

// The secret key prefix is the one honest signal we have for test mode; keys
// only ever come from env.
export function isTestModeKey(secretKey: string | null | undefined): boolean {
  return typeof secretKey === "string" && secretKey.startsWith("sk_test_");
}

// ---- Checkout params ---------------------------------------------------------

export type CheckoutParamsArgs = {
  userId: string;
  interval: BillingInterval;
  baseUrl: string;
  priceId: string;
};

// The user id travels in three places on purpose: client_reference_id ties the
// session to the account, session metadata is read back on checkout events,
// and subscription metadata rides every later subscription webhook, which is
// the only one of the three that survives past the first invoice.
export function buildCheckoutParams(args: CheckoutParamsArgs): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    client_reference_id: args.userId,
    metadata: { user_id: args.userId },
    subscription_data: { metadata: { user_id: args.userId } },
    success_url: `${args.baseUrl}/billing?status=success`,
    cancel_url: `${args.baseUrl}/billing?status=canceled`,
    allow_promotion_codes: true,
    line_items: [{ price: args.priceId, quantity: 1 }],
  };
}

export type PayNowParamsArgs = {
  userId: string;
  baseUrl: string;
  priceId: string;
};

// PayNow cannot recur, so the yearly plan is a one-time charge that buys a
// fixed year of Pro. metadata.kind marks the session so the webhook can tell
// it apart from a subscription checkout. allowed_payment_method_types is the
// filter this SDK version exposes (payment_method_types was removed).
export function buildPayNowParams(args: PayNowParamsArgs): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    allowed_payment_method_types: ["paynow"],
    client_reference_id: args.userId,
    metadata: { user_id: args.userId, kind: "paynow_yearly" },
    success_url: `${args.baseUrl}/billing?status=success`,
    cancel_url: `${args.baseUrl}/billing?status=canceled`,
    line_items: [{ price: args.priceId, quantity: 1 }],
  };
}

// ---- Stripe objects to subscription rows ------------------------------------

// Loose structural views so tests can hand-make objects; the SDK's own types
// satisfy these.
export type StripeSubscriptionLike = {
  id: string;
  status?: string | null;
  metadata?: Record<string, string> | null;
  customer?: string | { id?: string } | null;
  items?: { data?: Array<{ current_period_end?: number }> } | null;
  // Older API versions kept the period end on the subscription itself; newer
  // ones (this SDK) keep it per item. Both are read defensively.
  current_period_end?: number;
};

export type StripeCheckoutSessionLike = {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  client_reference_id?: string | null;
  subscription?: string | null;
  metadata?: Record<string, string> | null;
};

export type StripeInvoiceLike = {
  id: string;
  subscription?: string | null;
};

export type StripeBillingStatus = "active" | "past_due" | "canceled";

// Unknown statuses map to canceled: an unmapped Stripe status must never
// unlock Pro.
export function mapStripeStatus(status: string | null | undefined): StripeBillingStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    default:
      return "canceled";
  }
}

// End of the current billing period, from the first item that carries one,
// falling back to the legacy top-level field.
export function periodEndFromSubscription(sub: StripeSubscriptionLike): Date | null {
  const fromItems = sub.items?.data?.find(
    (item) => typeof item.current_period_end === "number",
  )?.current_period_end;
  const seconds =
    typeof fromItems === "number"
      ? fromItems
      : typeof sub.current_period_end === "number"
        ? sub.current_period_end
        : null;
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

export type StripeSubscriptionUpsert = {
  userId: string;
  provider: "stripe";
  providerRef: string;
  plan: "pro";
  status: StripeBillingStatus;
  currentPeriodEnd: Date | null;
};

export function subscriptionRowFromStripe(
  sub: StripeSubscriptionLike,
  userId: string,
): StripeSubscriptionUpsert {
  return {
    userId,
    provider: "stripe",
    providerRef: sub.id,
    plan: "pro",
    status: mapStripeStatus(sub.status),
    currentPeriodEnd: periodEndFromSubscription(sub),
  };
}

// One-time PayNow year: no renewal, so the period is a flat 365 days from the
// moment the webhook processes the paid session.
export const PAYNOW_PERIOD_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function paynowRowFromSession(
  session: StripeCheckoutSessionLike,
  userId: string,
  now: Date,
): StripeSubscriptionUpsert {
  return {
    userId,
    provider: "stripe",
    providerRef: `paynow:${session.id}`,
    plan: "pro",
    status: "active",
    currentPeriodEnd: new Date(now.getTime() + PAYNOW_PERIOD_DAYS * DAY_MS),
  };
}

export function customerIdFromSubscription(sub: StripeSubscriptionLike): string | null {
  if (typeof sub.customer === "string") return sub.customer;
  const id = sub.customer?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function buildPortalParams(
  customer: string,
  baseUrl: string,
): Stripe.BillingPortal.SessionCreateParams {
  return { customer, return_url: `${baseUrl}/billing` };
}

// ---- Webhook handling --------------------------------------------------------

export type StripeEventLike = {
  id: string;
  type: string;
  data: { object: unknown };
};

export type BillingEventInputLike = {
  id: string;
  provider: string;
  payload: unknown;
};

export type StripeWebhookDeps = {
  findBillingEvent: (id: string) => Promise<boolean>;
  recordBillingEvent: (event: BillingEventInputLike) => Promise<void>;
  deleteBillingEvent: (id: string) => Promise<void>;
  upsertSubscription: (row: StripeSubscriptionUpsert) => Promise<void>;
  retrieveSubscription: (id: string) => Promise<StripeSubscriptionLike | null>;
  now?: () => Date;
  log?: (message: string) => void;
};

export type StripeEventOutcome =
  | { kind: "processed"; type: string }
  | { kind: "duplicate" }
  | {
      kind: "ignored";
      type: string;
      reason: "unhandled_type" | "bad_user" | "not_paid" | "missing_subscription";
    };

const UUID = z.uuid();
const HANDLED_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

function logTo(deps: StripeWebhookDeps): (message: string) => void {
  return deps.log ?? ((message) => console.log(message));
}

function nowOf(deps: StripeWebhookDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

// The user id is only ever read from fields we wrote at checkout creation:
// client_reference_id first, then metadata.user_id. Anything that is not a
// uuid is garbage and gets ignored, never turned into a row.
function userIdFromCheckout(session: StripeCheckoutSessionLike): string | null {
  const candidate = session.client_reference_id ?? session.metadata?.user_id ?? null;
  return candidate !== null && UUID.safeParse(candidate).success ? candidate : null;
}

function userIdFromMetadata(metadata: Record<string, string> | null | undefined): string | null {
  const candidate = metadata?.user_id ?? null;
  return candidate !== null && candidate !== undefined && UUID.safeParse(candidate).success
    ? candidate
    : null;
}

// Minimal support summary only: the raw event carries customer PII that has no
// business sitting in billing_events.
function eventPayload(event: StripeEventLike, objectId: string, userId: string | null) {
  return { type: event.type, object_id: objectId, user_id: userId };
}

function subscriptionIdOf(owner: { subscription?: string | null }): string | null {
  return typeof owner.subscription === "string" && owner.subscription.length > 0
    ? owner.subscription
    : null;
}

async function upsertFromSubscription(
  deps: StripeWebhookDeps,
  sub: StripeSubscriptionLike,
  userId: string,
  statusOverride: StripeBillingStatus | undefined,
): Promise<void> {
  const row = subscriptionRowFromStripe(sub, userId);
  await deps.upsertSubscription(statusOverride ? { ...row, status: statusOverride } : row);
}

async function dispatchStripeEvent(
  deps: StripeWebhookDeps,
  event: StripeEventLike,
): Promise<StripeEventOutcome> {
  const log = logTo(deps);
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as StripeCheckoutSessionLike;
      const userId = userIdFromCheckout(session);
      if (userId === null) {
        log(`[billing] stripe ${event.id}: no user on session ${session.id}, ignoring`);
        return { kind: "ignored", type: event.type, reason: "bad_user" };
      }
      if (session.mode === "subscription") {
        const subId = subscriptionIdOf(session);
        if (subId === null) {
          return { kind: "ignored", type: event.type, reason: "missing_subscription" };
        }
        const sub = await deps.retrieveSubscription(subId);
        if (sub === null) {
          // The session says a subscription exists; failing here (500) makes
          // Stripe retry until the read succeeds.
          throw new Error(`[billing] subscription ${subId} from session ${session.id} not found`);
        }
        await upsertFromSubscription(deps, sub, userId, undefined);
        return { kind: "processed", type: event.type };
      }
      if (session.mode === "payment") {
        if (session.metadata?.kind !== "paynow_yearly") {
          return { kind: "ignored", type: event.type, reason: "unhandled_type" };
        }
        if (session.payment_status !== "paid") {
          return { kind: "ignored", type: event.type, reason: "not_paid" };
        }
        await deps.upsertSubscription(paynowRowFromSession(session, userId, nowOf(deps)));
        return { kind: "processed", type: event.type };
      }
      return { kind: "ignored", type: event.type, reason: "unhandled_type" };
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as StripeSubscriptionLike;
      const userId = userIdFromMetadata(sub.metadata);
      if (userId === null) {
        log(`[billing] stripe ${event.id}: no user on subscription ${sub.id}, ignoring`);
        return { kind: "ignored", type: event.type, reason: "bad_user" };
      }
      await upsertFromSubscription(deps, sub, userId, undefined);
      return { kind: "processed", type: event.type };
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as StripeSubscriptionLike;
      const userId = userIdFromMetadata(sub.metadata);
      if (userId === null) {
        log(`[billing] stripe ${event.id}: no user on subscription ${sub.id}, ignoring`);
        return { kind: "ignored", type: event.type, reason: "bad_user" };
      }
      await upsertFromSubscription(deps, sub, userId, "canceled");
      return { kind: "processed", type: event.type };
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as StripeInvoiceLike;
      const subId = subscriptionIdOf(invoice);
      if (subId === null) {
        return { kind: "ignored", type: event.type, reason: "missing_subscription" };
      }
      const sub = await deps.retrieveSubscription(subId);
      if (sub === null) {
        throw new Error(`[billing] subscription ${subId} from invoice ${invoice.id} not found`);
      }
      const userId = userIdFromMetadata(sub.metadata);
      if (userId === null) {
        log(`[billing] stripe ${event.id}: no user on subscription ${sub.id}, ignoring`);
        return { kind: "ignored", type: event.type, reason: "bad_user" };
      }
      await upsertFromSubscription(deps, sub, userId, "past_due");
      return { kind: "processed", type: event.type };
    }
    default:
      return { kind: "ignored", type: event.type, reason: "unhandled_type" };
  }
}

// Order per the card: dedupe first, record the event, then process. A failure
// after recording removes the event again and rethrows, so the route answers
// 500 and Stripe retries the whole thing.
export async function handleStripeEvent(
  deps: StripeWebhookDeps,
  event: StripeEventLike,
): Promise<StripeEventOutcome> {
  const log = logTo(deps);
  if (!HANDLED_TYPES.has(event.type)) {
    return { kind: "ignored", type: event.type, reason: "unhandled_type" };
  }
  const eventId = `stripe:${event.id}`;
  if (await deps.findBillingEvent(eventId)) {
    return { kind: "duplicate" };
  }
  const object = event.data.object as { id?: unknown };
  const objectId = typeof object?.id === "string" ? object.id : "unknown";
  const userId =
    userIdFromCheckout(object as StripeCheckoutSessionLike) ??
    userIdFromMetadata((object as StripeSubscriptionLike).metadata);
  await deps.recordBillingEvent({
    id: eventId,
    provider: "stripe",
    payload: eventPayload(event, objectId, userId),
  });
  try {
    return await dispatchStripeEvent(deps, event);
  } catch (error) {
    log(`[billing] stripe event ${eventId} failed, removing the billing event for retry`);
    try {
      await deps.deleteBillingEvent(eventId);
    } catch (deleteError) {
      log(`[billing] failed to remove billing event ${eventId}: ${String(deleteError)}`);
    }
    throw error;
  }
}

// ---- Webhook wrapper ----------------------------------------------------------

export type ProcessWebhookArgs = {
  rawBody: string;
  signature: string | null | undefined;
  webhookSecret: string | null | undefined;
  verify: (rawBody: string, signature: string, webhookSecret: string) => unknown;
  handle: (event: unknown) => Promise<unknown>;
};

// The body is plain text on purpose: a success carries exactly the JSON
// ack Stripe expects, everything else a short non-informative string.
export type WebhookResult = { status: number; body: string };

// Pure decision table for the route: 503 unconfigured, 400 on a missing or bad
// signature, 200 once handled, 500 when the handler throws so Stripe retries.
export async function processStripeWebhook(args: ProcessWebhookArgs): Promise<WebhookResult> {
  if (typeof args.webhookSecret !== "string" || args.webhookSecret.length === 0) {
    return { status: 503, body: "Not configured" };
  }
  if (typeof args.signature !== "string" || args.signature.length === 0) {
    return { status: 400, body: "Bad signature" };
  }
  let event: unknown;
  try {
    event = args.verify(args.rawBody, args.signature, args.webhookSecret);
  } catch {
    return { status: 400, body: "Bad signature" };
  }
  try {
    await args.handle(event);
    return { status: 200, body: '{"received":true}' };
  } catch {
    return { status: 500, body: "Handler failed" };
  }
}

// ---- Action cores --------------------------------------------------------------

export const CHECKOUT_INTERVAL_SCHEMA = z.enum(["monthly", "yearly", "paynow"]);

export type CheckoutActionDeps = {
  sessionUserId: () => Promise<string>;
  billingEnabled: () => boolean;
  env: () => StripeEnvConfig;
  baseUrl: () => string;
  createSession: (params: Stripe.Checkout.SessionCreateParams) => Promise<{ url: string | null }>;
  log?: (message: string) => void;
};

const BILLING_ERROR_URL = "/billing?status=error";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Runs one checkout and returns the URL to redirect to, never throwing: the
// server action redirect target is the Stripe host on success and /billing
// with status=error on anything else. The user id comes only from the session;
// the interval is the single untrusted input and is schema checked here.
export async function startCheckoutFor(
  rawInterval: unknown,
  deps: CheckoutActionDeps,
): Promise<string> {
  const log = deps.log ?? ((message) => console.error(message));
  const parsed = CHECKOUT_INTERVAL_SCHEMA.safeParse(rawInterval);
  if (!parsed.success) return BILLING_ERROR_URL;
  if (!deps.billingEnabled()) return BILLING_ERROR_URL;
  const env = deps.env();
  if (!stripeConfigured(env)) return BILLING_ERROR_URL;
  const userId = await deps.sessionUserId();
  if (!UUID.safeParse(userId).success) return BILLING_ERROR_URL;
  const baseUrl = deps.baseUrl();
  try {
    if (parsed.data === "paynow") {
      const priceId = env.STRIPE_PRICE_PRO_YEARLY_PAYNOW;
      if (typeof priceId !== "string" || priceId.length === 0) return BILLING_ERROR_URL;
      const session = await deps.createSession(buildPayNowParams({ userId, baseUrl, priceId }));
      return session.url ?? BILLING_ERROR_URL;
    }
    const priceId = priceIdFor(parsed.data, env);
    if (priceId === null) return BILLING_ERROR_URL;
    const session = await deps.createSession(
      buildCheckoutParams({ userId, interval: parsed.data, baseUrl, priceId }),
    );
    return session.url ?? BILLING_ERROR_URL;
  } catch (error) {
    // One line, no secrets: Stripe errors carry no key material.
    log(`[billing] ${parsed.data} checkout failed for user ${userId}: ${describeError(error)}`);
    return BILLING_ERROR_URL;
  }
}

export type PortalActionDeps = {
  sessionUserId: () => Promise<string>;
  baseUrl: () => string;
  latestStripeRef: () => Promise<string | null>;
  retrieveSubscription: (id: string) => Promise<StripeSubscriptionLike | null>;
  createPortalSession: (
    params: Stripe.BillingPortal.SessionCreateParams,
  ) => Promise<{ url: string | null }>;
  log?: (message: string) => void;
};

// Customer Portal for cancel and update. Only a real subscription row
// (provider_ref sub_...) qualifies; a paynow:<session> ref has no portal.
export async function openPortalFor(deps: PortalActionDeps): Promise<string> {
  const log = deps.log ?? ((message) => console.error(message));
  try {
    const ref = await deps.latestStripeRef();
    if (ref === null || !ref.startsWith("sub_")) return BILLING_ERROR_URL;
    const sub = await deps.retrieveSubscription(ref);
    const customer = sub === null ? null : customerIdFromSubscription(sub);
    if (customer === null) return BILLING_ERROR_URL;
    const session = await deps.createPortalSession(buildPortalParams(customer, deps.baseUrl()));
    return session.url ?? BILLING_ERROR_URL;
  } catch (error) {
    log(`[billing] portal session failed: ${describeError(error)}`);
    return BILLING_ERROR_URL;
  }
}
