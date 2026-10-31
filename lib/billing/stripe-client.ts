import "server-only";
import Stripe from "stripe";
import { getEnv } from "@/lib/env";

// One Stripe client per process, built lazily so importing this module (and
// anything that re-exports it) never touches the environment at import time.
// Test and live are identical code: everything comes from env.
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  const { STRIPE_SECRET_KEY } = getEnv();
  if (typeof STRIPE_SECRET_KEY !== "string" || STRIPE_SECRET_KEY.length === 0) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  cached ??= new Stripe(STRIPE_SECRET_KEY);
  return cached;
}
