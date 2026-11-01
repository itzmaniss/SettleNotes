# Stripe Managed Payments

This is the owner guide for the `STRIPE_MANAGED_PAYMENTS` switch. The switch is `false` by default. With it off, Settle's web payments behave exactly as they did before this document existed. Nothing here changes Telegram Stars.

## What it is

Stripe Managed Payments makes Stripe the merchant of record (the seller) for Settle's web card subscriptions. Stripe sells the Settle Pro subscription to the student, handles sales tax, VAT and GST in more than 80 countries, handles fraud and disputes, and runs payment support through Link. Settle still builds and provides the service; only the selling and the tax side move to Stripe.

The code asks for it by sending `managed_payments[enabled]=true` on the checkout session, and only while the flag is on. Stripe must approve the account for Managed Payments before it works.

## What changes when it is on

- Stripe becomes the seller of record for web card payments. Telegram Stars is untouched: it stays a Telegram subscription bought with Stars.
- Stripe collects the student's name and billing address itself at checkout.
- Checkout shows Stripe's own terms. Our Terms and Privacy links for checkout, and the customer portal, are configured in the Stripe dashboard, not in code.
- Stripe controls invoicing, confirmation emails and receipts. Settle sets none of that.
- Stripe picks the payment methods. PayNow is not among them, so the one time PayNow year disappears everywhere while the flag is on: the button is not rendered, and any stale PayNow request gets a calm refusal instead of a session. The `STRIPE_PRICE_PRO_YEARLY_PAYNOW` variable is ignored until the flag goes back off.
- Adaptive Pricing is always on, so a buyer outside Singapore may see their local currency at checkout. Our webhook records the plan from the price id, never from the amount or currency, so billing stays correct either way.
- Tax is added on top of the price by default, unless the price itself or a dashboard setting says tax inclusive. That is an owner decision (see the checklist).
- Existing (non Managed Payments) subscriptions are not eligible for Managed Payments. Nothing is live yet, so there is no migration.

## The fee

Managed Payments costs 3.5 percent on top of the normal Stripe card fees, and that 3.5 percent is charged on the full amount the student pays, including any tax. Stripe Billing (subscriptions) is priced separately from this.

Example at S$7.99 a month: normal card fees are about S$0.77 and Managed Payments adds about S$0.28 on top of that.

The owner plans to raise prices to cover the fee. No new price is decided here.

## Where prices live

When prices change, every one of these places must change together. They are listed here, not changed:

- `lib/billing/plans.ts`, lines 50 and 51: `monthly: 7.99` and `yearly: 63.99`, the single source the website and the bot read.
- The Stripe price objects for the product, created in the Stripe dashboard (test and live). The price ids go into `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` and `STRIPE_PRICE_PRO_YEARLY_PAYNOW`.
- The legal text (drafts under `docs/legal/`): `01-terms-of-service-draft.md` (prices sentence), `03-payment-refund-draft.md` (Stripe prices line), `00-counsel-review-notes.md` (payment figures and the billing check item), `04-manager-fact-check.md` (the prices row).

Every other occurrence of the numbers 7.99 and 63.99 in the repo is tests, docs and design history, none of them change what a student pays:

- `tests/billing/plans.test.ts` (pins the plans.ts numbers)
- `tests/dashboard/lock-banner.test.tsx`, `tests/dashboard/plan.test.tsx` (assert prices do not leak)
- `tests/scripts/stats.test.ts` (MRR band numbers in comments)
- `docs/LAUNCH.md` (env table and Stripe test mode step)
- `docs/DEPLOY.md` (price setup walkthrough)
- `docs/TASKS.md`, `docs/PROGRESS.md` (history)
- `docs/design/MANAGER-BRIEF.md`, `docs/design/C-study-loud.html` (design references)

## Owner checklist, in order

1. In the Stripe dashboard, open Settings, then Managed Payments, enable it and accept its terms.
2. Wait for Stripe's eligibility review of the account. Nothing to do but wait; the flag stays off until this passes.
3. Edit the product and pick a tax code labelled "Eligible for Managed Payments". The code currently on the test product, `txcd_10203000`, may not be eligible: check the label shown in the dashboard and change it if it is not eligible.
4. Tax behavior. Decided by the owner on 1 November: prices are tax inclusive, so the price on the website is exactly what a student pays and any tax comes out of the owner's share. Set it in the Stripe dashboard (Settings, then Tax, then "Include tax in prices") in test mode first, then again in live mode, because Stripe adds tax on top of the price by default when nothing is set. The owner will adjust the prices after test mode if the margin is too thin.
   Also fix the product tax code: `txcd_10203000` is not on Stripe's Managed Payments list. Pick "Software as a service (SaaS) - personal use" (`txcd_10103000`, labelled eligible) on the product, which covers both prices.
5. In the dashboard, configure the checkout Terms and Privacy links and the customer portal for these subscriptions.
6. Set `STRIPE_MANAGED_PAYMENTS=true` on the server and restart the app.
7. Test in test mode with card `4242 4242 4242 4242`, from a few different billing countries, and check the subscriptions row, the Manage subscription button and a cancellation each time.

## Confirm in test mode before going live

These four are not yet verified by anyone and must be checked in test mode:

- `allow_promotion_codes` is accepted on a Managed Payments checkout session (Stripe's docs did not cover it; the code keeps codes on and drops them with a one line change if Stripe rejects them).
- The Manage subscription button (our customer portal session) still works for Managed Payments subscriptions; link.com also manages them.
- Webhook events arrive the same as for normal checkouts, so the subscriptions table keeps updating.
- Buyers outside Singapore really see their local currency at checkout.

## For counsel

Questions only; the legal text itself is written elsewhere. The current Terms, Privacy Policy and refund drafts assume Settle is the seller, so these need answers before the flag goes live:

- Who is the seller of record on the web when the flag is on, and which draft texts must change because of it?
- How do refunds work when Stripe can refund within 60 days in some cases, and may refund without approval if a support request goes unanswered for 48 hours?
- What must the Terms, Privacy Policy and refund drafts say now that Stripe, and Link, are additional recipients of student payment data?
- Does the consent wording (the accept buttons in the bot and on the web) need to mention Stripe Managed Payments or Link?

## Turning it off

Set `STRIPE_MANAGED_PAYMENTS=false` (or remove the variable) and restart the app. New checkouts go back to today's behavior, and the PayNow year option comes back. Subscriptions bought while the flag was on remain Managed Payments subscriptions with Stripe as seller of record until they end or are cancelled; their webhooks keep working the same way.
