# Manager fact check of the legal drafts against the product

**Date:** 31 October 2026. **Scope:** I checked what the drafts say about the product against the code, the database schema and the deploy files, and flagged legal-process gaps for counsel. This is not legal advice. The drafts in this folder were not edited. Code references are to the repository at the time of writing.

## A. Claims I verified as accurate

| Claim in the drafts | What the product does |
| --- | --- |
| Telegram identifiers and first name are stored | `users` keeps `telegram_user_id`, `telegram_chat_id`, `first_name` (`supabase/migrations/0001_init.sql`) |
| Uploads, transcripts, task history, checklists, flashcards, math explanations, weak spots are stored | `uploads` (incl. `text_content`), `tasks`, `task_events`, `starters`, `weak_spots`; original files and annotated images sit in the private `uploads` storage bucket |
| Login tokens are short-lived, session cookie lasts seven days | Magic link tokens are stored hashed, single use, 15 minutes; session cookie is HttpOnly and lasts 7 days |
| No AI training by Settle | No code path exports or reuses submissions; AI calls log only counts and cost (`ai_calls`: purpose, model, tokens, cost, latency, no prompts or outputs) |
| No analytics or advertising cookies or scripts | No analytics code found. Fonts are served from our own origin by Next.js at build time (re-check on the production build) |
| Stripe handles card data | The app never sees card numbers; checkout and the customer portal are Stripe-hosted |
| Cancel in the billing page or in Telegram, access runs to the end of the paid period | `/billing` opens the Stripe portal; a Stars subscriber is told to manage it in Telegram; access follows `current_period_end` |
| Prices S$7.99, S$63.99, 600 Stars each 30 days | Match `lib/billing/plans.ts` and the 30 day Stars subscription period |
| First payment refundable within 7 days | `/paysupport` uses `REFUND_WINDOW_DAYS = 7`; a Stars refund script exists (`scripts/refund-stars.ts`) |
| Terms and Privacy accepted before account creation and before payment | Built as card T22b (Telegram button, web `/accept` page, payment gates). In progress at the time of writing |

## B. Mismatches and gaps to fix before publishing

Ordered by risk.

1. **No account deletion or export exists, so the 60 day deletion promise and access requests cannot be honoured yet.** The counsel pack already notes this (item 5). Details: deleting a `users` row cascades to uploads, tasks, events, starters, weak spots, subscriptions, usage rows, pending actions and login tokens, and `ai_calls.user_id` is set to null (cost records stay, identity goes). It does **not** remove files from the storage bucket, and it does not touch `billing_events`, whose Stars payloads still contain the user's id inside the invoice payload. There is no script for either deletion or access/export. Proposed card T24: operator scripts `delete-user` and `export-user` (dry run by default), storage cleanup by user prefix, a decision on how long payment records are kept, and a documented request process. Until then, do not publish the 60 day promise.
2. **PayNow is built but the drafts exclude it.** The yearly PayNow one-time option is live in the code whenever `STRIPE_PRICE_PRO_YEARLY_PAYNOW` is set. It is optional and unset by default. Keep it unset until the refund and renewal text covers a one-time year, or the option is deleted.
3. **Third-party script on the login page.** `/login` loads Telegram's login widget script from `telegram.org`, so Telegram sees the visit. Stripe's checkout and portal pages are also third-party. The Privacy Notice section 3 and 6 should say so.
4. **A second essential cookie.** The new web consent step sets a short-lived (10 minute) signed cookie while a person decides whether to accept. Privacy Notice section 6 mentions only the session cookie.
5. **Prices are typed into legal text.** Terms section 6 and the payments page repeat the figures and call them "proposed". The two places will drift from `plans.ts` when a price changes. Fix: publish the final wording without "proposed", and add a test that fails when a figure on a legal page differs from `plans.ts`.
6. **"Support messages" in Privacy section 1.** There is no support channel inside the product. Support is by email. The bot's `/paysupport` reply says "message the person who runs this bot" and should name the support email once counsel approves it.
7. **No age step in the consent flow.** The drafts say students 15 and over. The consent screens ask for no age confirmation, on purpose, because that is counsel's call (counsel notes item 2). If an age line is wanted it is one string in `lib/legal/consent-copy.ts` and one stored value.
8. **Operator identity and the DPO.** PDPA section 11 requires an organisation to designate at least one individual responsible for compliance and to make that person's business contact information available to the public.[1] The draft leaves this open. The privacy page can carry the contact; counsel should confirm the designation and whether the PDPC registry is also expected.
9. **No breach response process.** The PDPC guide sets notification to the PDPC within three calendar days of ascertaining that a breach is notifiable.[2] The repository has no incident runbook. Proposed: a one page `docs/INCIDENT.md` (who decides, what to preserve, key rotation steps for the service key, bot token, Stripe and Meta keys, who to notify).
10. **Other people's data in screenshots.** The core feature reads classmates' names and messages in group chat screenshots. Terms section 3 puts the duty on the student. Counsel should consider whether that is enough, and whether the product should warn students at upload time. Product side: real fixtures are git-ignored (`tests/fixtures/real/`), and demo videos and README images must blur names.
11. **Overseas processing wording.** Supabase's own FAQ separates the project region from support access, logs and CDN delivery,[3] which the privacy draft already reflects. Keep the "we will not claim all data stays in Singapore" line, and date-stamp the statements about Meta, Telegram and Stripe terms so they do not read as permanent.
12. **Refund mechanics need a runbook.** A Stripe refund is manual in the Stripe dashboard and must be paired with cancelling the subscription, or renewals continue. A Stars refund is the script. The "7 days from the first charge" check is manual. Add a short refund runbook to `docs/LAUNCH.md`. Also: the Stripe customer portal must be configured with cancellation enabled in the Stripe dashboard, or the Manage subscription button fails.
13. **Repository hygiene.** `docs/legal/` is not git-ignored and holds the operator's full name, the support email and candid risk notes. The repository is public. Ignore the folder (or move it out of the repository) until counsel's final text exists; the published pages will carry only what counsel approves.
14. **Version sync.** When the final texts are published, set `TERMS_VERSION` (`lib/legal/version.ts`) to the effective date, so every existing student is asked to accept again.

## C. Done well

- Honest about what is not built yet (deletion, anonymisation, secondary use) and keeps it off by default.
- Cancellation versus refund is stated plainly, with the seven day first payment rule consistent across the three documents and the bot.
- Does not promise Singapore-only processing.
- Separates optional secondary use from the core service.

## Sources

[1] https://sso.agc.gov.sg/Act/PDPA2012?ProvIds=pr11- - PDPA 2012, section 11 (Compliance with Act), Singapore Statutes Online
[2] https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/other-guides/guide-on-managing-and-notifying-data-breaches-under-the-pdpa-15-mar-2021.pdf - PDPC, Guide on Managing and Notifying Data Breaches under the PDPA (15 Mar 2021)
[3] https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq - Supabase data residency and transfers FAQ (cited in the counsel pack)
