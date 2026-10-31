import { describe, expect, test } from "bun:test";
import { processStripeWebhook } from "../../lib/billing/stripe";

const SECRET = "whsec_test_123";

// The verify fake mirrors stripe.webhooks.constructEvent: throws on a bad
// signature, returns a plain event otherwise.
function verifyLikeStripe(rawBody: string, signature: string, secret: string): unknown {
  if (secret !== SECRET || signature === "bad") {
    throw new Error("Unexpected signature");
  }
  return { id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } };
}

describe("processStripeWebhook", () => {
  test("not configured answers 503 without touching the body", async () => {
    const result = await processStripeWebhook({
      rawBody: "{}",
      signature: "sig",
      webhookSecret: undefined,
      verify: verifyLikeStripe,
      handle: async () => {},
    });
    expect(result.status).toBe(503);
    expect(result.body).toBe("Not configured");
  });

  test("a blank webhook secret is also 503", async () => {
    const result = await processStripeWebhook({
      rawBody: "{}",
      signature: "sig",
      webhookSecret: "",
      verify: verifyLikeStripe,
      handle: async () => {},
    });
    expect(result.status).toBe(503);
  });

  test("missing signature header answers 400", async () => {
    for (const signature of [null, undefined, ""]) {
      const result = await processStripeWebhook({
        rawBody: "{}",
        signature,
        webhookSecret: SECRET,
        verify: verifyLikeStripe,
        handle: async () => {},
      });
      expect(result.status).toBe(400);
      expect(result.body).toBe("Bad signature");
    }
  });

  test("invalid signature answers 400 and never calls the handler", async () => {
    let handled = 0;
    const result = await processStripeWebhook({
      rawBody: "{}",
      signature: "bad",
      webhookSecret: SECRET,
      verify: verifyLikeStripe,
      handle: async () => {
        handled += 1;
      },
    });
    expect(result.status).toBe(400);
    expect(result.body).toBe("Bad signature");
    expect(handled).toBe(0);
  });

  test("valid signature and handled event answers 200 received", async () => {
    let seen: unknown = null;
    const result = await processStripeWebhook({
      rawBody: '{"id":"evt_1"}',
      signature: "good",
      webhookSecret: SECRET,
      verify: verifyLikeStripe,
      handle: async (event) => {
        seen = event;
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"received":true}');
    expect(seen).toEqual({
      id: "evt_1",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1" } },
    });
  });

  test("a throwing handler answers 500 so Stripe retries", async () => {
    const result = await processStripeWebhook({
      rawBody: "{}",
      signature: "good",
      webhookSecret: SECRET,
      verify: verifyLikeStripe,
      handle: async () => {
        throw new Error("db down");
      },
    });
    expect(result.status).toBe(500);
    expect(result.body).toBe("Handler failed");
  });
});
