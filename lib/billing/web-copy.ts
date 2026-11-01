// Client-safe copy: no imports on purpose. components/marketing/pricing-section.tsx
// is a client component, so anything it imports must never reach the
// server-only database layer.
export const WEB_NUDGE_LINE = "Subscribe on the web with a card or PayNow.";
// Shown under the Manage subscription button only while Stripe Managed
// Payments is on (link.com also lists, changes and cancels those plans).
export const MANAGED_PORTAL_LINE = "You can also manage your subscription at link.com.";
