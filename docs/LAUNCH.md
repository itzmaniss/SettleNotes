# Launch runbook: opening Settle to the public

Every step carries one OWNER tag: **[User]** means only the account owner can do it (passwords, dashboards, real money), **[Manager]** means the person running this runbook. Steps are in order. Do them top to bottom, tick as you go. The general server work is documented once in `docs/DEPLOY.md`; this file does not repeat it.

Rule zero, the reason the order below matters: with `BILLING_ENABLED=false` every user counts as Pro with unlimited AI at the owner's cost. The bot only opens to everyone while billing is ON. Never flip `ALLOWLIST_ENABLED=false` while `BILLING_ENABLED` is not `true`.

## 1. Preconditions (before touching any server)

- [ ] **[Manager]** The whole gate is green on the commit being deployed:

```
bun run typecheck && bun run lint && bun test && bun run build
```

- [ ] **[Manager]** Run the smoke script against the staging URL (or the running container) and expect zero FAIL:

```
bun run scripts/smoke.ts https://staging.example.com
```

- [ ] **[Manager]** Run the stats script once and confirm it prints numbers instead of an error (it is read only, safe on production):

```
bun run scripts/stats.ts --days 7
```

### Consent and legal

Settle only creates an account after a person accepts the Terms and the Privacy Policy, in the bot (the agree button) and on the web (the /accept page). These steps gate the launch:

- [ ] **[User]** The legal pages ship with the app at `/terms`, `/privacy` and `/refund` and return 200. The consent buttons in the bot and on `/accept` link to them, so the gate must not go live while they error or show unresolved review notes.
- [ ] **[User]** Set `LEGAL_BUSINESS_NAME`, `LEGAL_BUSINESS_UEN`, `LEGAL_SUPPORT_EMAIL` and `LEGAL_SUPABASE_REGION` in the server env file (`/opt/settle.env`). The business name and the UEN come from the ACRA registration; they are public business details, never the owner's personal details. The support email must never be committed to the repository.
- [ ] **[Manager]** Run `bun --env-file=/opt/settle.env run scripts/check-legal.ts` and confirm it exits 0. Today there are no `[[COUNSEL: ...]]` lines left in the legal text, but any future `[[COUNSEL: ...]]` line or missing setting makes the check exit 1 and print the file and line.
- [ ] **[User]** Register the business with ACRA via BizFile+ and note the UEN. Use the same legal name and UEN when activating the live Stripe account.
- [ ] **[User]** Before launch, confirm the data protection terms with each provider that handles student data outside Singapore: Supabase (its data processing addendum), Stripe (the data processing terms inside its services agreement), and Meta (the Model API terms). Keep the date and link of each in your own notes, because the Privacy Notice says contract terms back the overseas transfers.
- [ ] **[User]** The website runs on the owner's own server: if traffic reaches it through a proxy, tunnel or DNS service (for example Cloudflare), add that company to the "Who else handles your information" list in `content/legal/privacy.md` before launch (tell the manager; the manager edits the text).
- [ ] **[Manager]** Refunds for payers under 18 who had no parent or guardian's permission are NEVER promised: handle each case by hand at the owner's discretion, and cancel the subscription in the same step.
- [ ] **[User]** When counsel's approved text goes live, bump `TERMS_VERSION` in `lib/legal/version.ts` to that day, so everyone is asked to accept again.
- [ ] **[User]** Singapore counsel has reviewed the legal pages and the consent wording in `lib/legal/consent-copy.ts`, especially whether wording about young readers, an age confirmation or liability language is needed. That call is counsel's, not this runbook's.
- [ ] **[User]** Whenever the Terms or the Privacy Policy texts change, bump `TERMS_VERSION` in `lib/legal/version.ts` to the effective date, so everyone is asked to accept again.
- [ ] **[Manager]** Apply `supabase/migrations/0004_terms_acceptance.sql` before deploying this code, with the user's go. It adds the two nullable acceptance columns; without it every login fails closed.
- [ ] **[Manager]** After the legal pages ship, re-run the smoke script: the three `legal page` lines must read PASS. A missing page or an unresolved `[[COUNSEL: ...]]` marker over https is now a FAIL, not a WARN; over plain http it is a WARN.
- [ ] **[User]** Keep `STRIPE_PRICE_PRO_YEARLY_PAYNOW` unset until the Terms and the refund text cover a one time yearly PayNow payment. Leaving it blank hides the PayNow button; filling it earlier would sell a plan the legal text does not describe yet.
- [ ] **[User]** In the Stripe dashboard, configure the customer portal with cancellation enabled (test mode first, then live) before testing the Manage subscription button.
- [ ] **[User]** Optional, decide before launch: Stripe Managed Payments (Stripe becomes the seller of record for web card payments and handles tax) ships behind the `STRIPE_MANAGED_PAYMENTS` env switch, `false` by default, so leaving it unset changes nothing. Read `docs/STRIPE-MANAGED-PAYMENTS.md` first: it explains the fee, lists an owner checklist (Stripe dashboard setup, eligibility review, tax code, tax behavior, checkout links, portal) and what to confirm in test mode. With it on, the PayNow year option is hidden and Stripe also manages refunds and payment support through Link.


## 2. Infrastructure

Follow `docs/DEPLOY.md` sections "What you need", "Environment variables", "The env file", "DNS, firewall, first deploy". Summary of what must exist, in this order:

- [ ] **[User]** A VPS the owner controls, Docker plus the compose plugin installed.
- [ ] **[User]** The domain, with an A record pointing at the server IP.
- [ ] **[Manager]** Caddy running in front for https (compose file in `deploy/`).
- [ ] **[Manager]** The env file on the server (path `/opt/settle.env` in the compose file), every variable filled, then `chmod 600`. Variable names and where each value comes from:

| Name | Owner | Where it comes from |
| --- | --- | --- |
| TELEGRAM_BOT_TOKEN | User | @BotFather, the bot's token. |
| TELEGRAM_BOT_USERNAME | User | The bot username without the @. |
| TELEGRAM_WEBHOOK_SECRET | Manager | `openssl rand -hex 32`. |
| ALLOWED_TELEGRAM_IDS | User | The owner's and testers' Telegram numeric ids (@userinfobot). |
| ALLOWLIST_ENABLED | Manager | Leave `true` until step 7. |
| MODEL_API_KEY | User | dev.meta.ai, API keys. |
| META_API_BASE_URL | Manager | Default `https://api.meta.ai/v1`, leave as is. |
| META_MODEL | Manager | Default `muse-spark-1.3`, leave as is. |
| META_TRANSCRIBE_MODEL | Manager | Default `muse-voice-transcribe-1.0`, leave as is. |
| META_DAILY_BUDGET_USD | User | Daily AI spend stop in USD. Keep it set, default 10. |
| SUPABASE_URL | User | Supabase, Project Settings, API tab. |
| SUPABASE_SECRET_KEY | User | Supabase, the `sb_secret_...` key. |
| SUPABASE_STORAGE_BUCKET | Manager | Default `uploads`, leave as is. |
| SUPABASE_DB_URL | User | Supabase, Project Settings, Database, connection string. |
| SESSION_SECRET | Manager | `openssl rand -hex 32`. |
| APP_BASE_URL | Manager | `https://settle.example.com`, the public https URL. |
| BILLING_ENABLED | Manager | `false` until step 7, then `true`. |
| STRIPE_SECRET_KEY | User | Stripe dashboard, test key `sk_test_...` first. |
| STRIPE_WEBHOOK_SECRET | Manager | From the Stripe webhook endpoint, `whsec_...`. |
| STRIPE_PRICE_PRO_MONTHLY | User | Stripe price id for S$7.99 a month. |
| STRIPE_PRICE_PRO_YEARLY | User | Stripe price id for S$63.99 a year. |
| STRIPE_PRICE_PRO_YEARLY_PAYNOW | User | Stripe one time price id for the PayNow year, optional. |

- [ ] **[Manager]** App container up and healthy: `docker compose -f deploy/docker-compose.yml ps` shows the app healthy and `curl -s https://settle.example.com/api/health` prints `{"ok":true}`.

## 3. Database

- [ ] **[Manager]** Apply the migrations in order in the Supabase SQL editor: `supabase/migrations/0001_init.sql`, then `0002_billing.sql`, then `0003_pending_actions.sql`, then `0004_terms_acceptance.sql`, then `0005_purchase_confirmations.sql`, then anything newer in `supabase/migrations/` by number. One file at a time, each in one transaction.
- [ ] **[Manager]** Verify with counts (SQL editor, read only):

```sql
select count(*) from users;
select count(*) from subscriptions;
select count(*) from usage_events;
select count(*) from pending_actions;
```

Four numbers, no errors, is a pass. These tables already exist from earlier deploys; a fresh project starts at zero for all of them.

## 4. Telegram

- [ ] **[User]** In @BotFather, `/setdomain` with the bare production domain (no https, no path), so the web login widget is allowed to run.
- [ ] **[User]** Check the bot's privacy mode: BotFather, `/setprivacy`, disabled, so the bot can read group messages it is mentioned in. (Group use needs this; private chats always work.)
- [ ] **[Manager]** Register the webhook with the allowed updates (message, callback_query and pre_checkout_query; payments never arrive without the last one):

```
bun --env-file=/opt/settle.env run scripts/set-webhook.ts
```

- [ ] **[User]** In BotFather, `/setcommands` and paste exactly this list:

```
start - say hi and get your dashboard link
help - what Settle understands
dashboard - open your task list on the web
tasks - your next few tasks
done - tick one off, like /done 1
pro - about Settle Pro
paysupport - help with a payment
```

- [ ] **[Manager]** Send `/start` from an allowlisted account and get a reply.

## 5. Stripe, test mode first, then live

- [ ] **[User]** Stripe test mode: create the product `Settle Pro` with the S$7.99 monthly and S$63.99 yearly recurring prices, plus the one time S$63.99 price for PayNow. Copy the three price ids into the env file (`STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`, `STRIPE_PRICE_PRO_YEARLY_PAYNOW`).
- [ ] **[User]** Add a webhook endpoint in Stripe pointing at `https://settle.example.com/api/stripe/webhook` with the four events listed in `docs/DEPLOY.md` (checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed). Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and restart the app.
- [ ] **[User]** Put the test key into `STRIPE_SECRET_KEY`. Keep `sk_test_` values until step 8 of this section has passed.
- [ ] **[Manager]** Local webhook forwarding when needed:

```
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

- [ ] **[User]** Test mode confirm gate check: Telegram: /pro shows the confirm prompt, no invoice until the tap; web: checkout needs the tick; a purchase_confirmations row appears per tap.
- [ ] **[User]** Test purchases with the card `4242 4242 4242 4242`: monthly, yearly, and the PayNow year. After each: the `subscriptions` row exists (active, right provider), and `/billing` shows Pro with the Manage subscription button. Test a cancel from the customer portal and confirm the row goes `canceled`.
- [ ] **[User]** Switch to live keys when everything above passed: activate the Stripe account, create the same product and prices in live mode, add the live webhook endpoint, then replace the five Stripe values in the env file and restart. No code changes.

## 6. Telegram Stars

- [ ] **[User]** From the owner's Telegram account, send `/pro` to the bot and buy one month with Stars when the invoice appears (the Stars price comes from `lib/billing/plans.ts`). Expect the activation message and an active `stars` row in `subscriptions`.
- [ ] **[Manager]** If a refund is needed, note the `telegram_payment_charge_id` from the `subscriptions` row, then:

```
bun --env-file=/opt/settle.env run scripts/refund-stars.ts --user <telegram user id> --charge <charge id>
```

Dry run by default; add `--yes` to execute.

## 7. THE SWITCH (order matters)

- [ ] **[Manager]** First `BILLING_ENABLED=true` in the env file. Keep `ALLOWLIST_ENABLED=true`. Restart the app:

```
docker compose -f deploy/docker-compose.yml up -d --force-recreate app
```

- [ ] **[Manager]** Verify with billing on and the allowlist still on: send a math photo from an allowlisted account, use up the free quota if practical (or set a tiny quota in a staging env) and check the quota reply mentions the reset date; open `/dashboard` and confirm the Plan card renders with usage numbers.
- [ ] **[Manager]** Now set `ALLOWLIST_ENABLED=false`. Restart again. Why this order: with billing off, every user is Pro with unlimited AI, so opening the bot first would let strangers spend the owner's money. Billing on means every new user is Free with small monthly quotas and the daily cap.
- [ ] **[Manager]** Run the smoke script and the stats script against production:

```
bun run scripts/smoke.ts https://settle.example.com
bun --env-file=/opt/settle.env run scripts/stats.ts
```

- [ ] **[Manager]** From an account NOT on `ALLOWED_TELEGRAM_IDS`, send `/start`. Expect a normal welcome (the bot is open). Then send one photo and confirm a task is created and the Plan card counts it.

## 8. First hour watch list

- [ ] **[Manager]** Watch the app log: `docker compose -f deploy/docker-compose.yml logs -f app`. Look for repeated `[telegram] handler error` or `[billing]` lines.
- [ ] **[Manager]** Watch AI spend: `META_DAILY_BUDGET_USD` is the hard stop; the stats script prints cost today (SGT) and cost by purpose:

```
bun --env-file=/opt/settle.env run scripts/stats.ts --days 1
```

- [ ] **[Manager]** Capture these numbers for the presentation (rerun the stats script, or use `--json` to copy exact values): users total, new users in the last 24 hours, uploads total, AI cost total, cost today, active subscriptions by provider, estimated monthly recurring revenue, Stars subscribers.
- [ ] **[Manager]** Check the daily upload cap behaves: a student who somehow sends more than the daily cap in a day gets the pause-for-today reply and nothing breaks.

## 9. Rollback

- [ ] **[Manager]** Close the bot again instantly: set `ALLOWLIST_ENABLED=true` in the env file and restart the app container. Existing sessions and subscriptions are untouched; the web login gate closes with the bot because it reads the same policy. `BILLING_ENABLED` stays `true`.
- [ ] **[Manager]** Revert the image if the new build itself is bad (see `docs/DEPLOY.md`, "Rollback"):

```
docker tag settle:latest settle:broken
docker tag settle:previous settle:latest
docker compose -f deploy/docker-compose.yml up -d --force-recreate app
```

- [ ] **[Manager]** Refund a Stripe payment from the Stripe dashboard (Payments, the charge, Refund); the webhook marks the subscription canceled. Refund Stars with `scripts/refund-stars.ts` (step 6). A refunded student keeps their tasks; only Pro features relock.

## 10. Known limits, not built

- No account merging. A student who switches Telegram accounts gets a new, empty account; moving tasks between accounts is a manual database job.
- No email receipts. Stripe emails receipts; Stars payments have no email receipt, the Telegram payment message is the record.
- No tax handling. Prices are as configured; GST or anything similar is the owner's bookkeeping.
- The subscriptions row does not record monthly versus yearly, so the stats script prints the MRR as a clearly labelled band, not an exact figure.
- The Vercel deployment stays a demo. It has its own env and its own database assignment history; do not point users at it.

## 11. Handling a data request

A student can ask for a copy of their data, or ask you to delete it. Singapore's PDPA lets them make that request by email; the bot has no self service button for it. The two scripts do the work; this section is the process. Where every place data lives, how long it stays and how it is removed is written down in `docs/DATA-MAP.md`; read it once before you handle the first request.

Proposed service levels, clearly marked as proposals until counsel agrees them: acknowledge any data request within 7 days, and complete a verified request within 30 days. Both are proposals, not yet agreed; if you cannot meet one, tell the student when they will get an answer.

- [ ] **[Manager]** Verify the person is who they say they are BEFORE running anything. An email address is not proof. Confirm the request from the Telegram account itself: email the student a one time phrase, send the same phrase to them through the bot from your operator Telegram account, and ask them to reply by email quoting it. Only the person who controls that Telegram account can see the phrase in the bot chat. A dashboard login link sent through the bot works the same way. If they cannot confirm from the Telegram account, stop and do not run the scripts.
- [ ] **[Manager]** For an access request (a copy of their data):

```
bun --env-file=/opt/settle.env run scripts/export-user.ts --telegram-id <id> --out <file.json>
```

The script is read only. It refuses to overwrite an existing file and refuses paths inside the repository, because the file holds personal data and must stay out of git. It writes the file with mode 0600. Send the file to the student by email, then delete it securely.

- [ ] **[Manager]** For an erasure request, run the delete script as a dry run first:

```
bun --env-file=/opt/settle.env run scripts/delete-user.ts --telegram-id <id>
```

Read the counts. If they look wrong for this student, stop and check the id again. Then add `--yes` to erase. The script scrubs the payment payloads first, removes the stored files, then deletes the users row so the database cascade removes everything else; `ai_calls` rows are kept but anonymised. Payment rows themselves stay for accounting and dedupe, with identifying fields removed.
- [ ] **[Manager]** After a successful erase the script lists the Stripe subscription ids it saw and prints the reminder that Stripe keeps its own record for tax and accounting (handle it in the Stripe dashboard only if your accounting rules allow, and note the date), plus the reminder that Telegram keeps its own payment record when the student ever paid with Stars. The erase never contacts Stripe or Telegram itself.
- [ ] **[Manager]** If the student still has an active subscription the script blocks and tells you what to cancel first: Stripe ones in the Stripe dashboard, Stars ones by the student in Telegram, PayNow ones simply run out. `--force` skips that check, but warn the student first: Stripe or Telegram may still charge them.
- [ ] **[Manager]** Reply to the student by email when it is done. Proposed service level: acknowledge the request within 7 days and finish a verified request within 30 days (a proposal; it sits inside the 60 days the draft privacy notice in docs/legal mentions). If you cannot finish in time, tell them when they will get an answer.
- [ ] **[Manager]** Keep a note of the request date, what you did, and the date you did it, in your own private log. The scripts do not keep one for you.
- [ ] **[Manager]** Once a quarter (proposed), run the stale account sweep and review the list:

```
bun --env-file=/opt/settle.env run scripts/stale-accounts.ts --days 365
```

The sweep is read only. It lists accounts with no activity for the threshold days and no live subscription, with the Telegram id you need for the scripts above. Review each account on the list before doing anything, and never erase an account just because it appears: the list is a prompt to look, not an instruction to erase.

## 12. Refunds

The money steps, per payment method. Tell the student by email in every case, and remember a refunded student keeps their tasks; only Pro features relock.

- [ ] **[Manager]** Refunds for payers under 18 who had no parent or guardian's permission are NEVER promised: handle each case by hand at the owner's discretion, and cancel the subscription in the same step.

### Stripe card, monthly or yearly

- [ ] **[Manager]** Refund in the Stripe dashboard (Payments, the payment, Refund) AND cancel the subscription in the same sitting (Subscriptions, then Cancel). A refund alone does not stop the next renewal.
- [ ] **[Manager]** With Managed Payments on (`STRIPE_MANAGED_PAYMENTS=true`), Stripe may also issue refunds on its own within 60 days, and it can refund without approval when a support request goes unanswered for 48 hours; student payment support requests then go through Link instead of you. Same webhook events arrive either way, so the subscriptions table stays correct without extra work. See `docs/STRIPE-MANAGED-PAYMENTS.md`.

### Telegram Stars

- [ ] **[Manager]** Check the first charge date first: the promise is a refund within seven days of the first charge (`REFUND_WINDOW_DAYS` in `lib/billing/stars.ts`). Then:

```
bun --env-file=/opt/settle.env run scripts/refund-stars.ts --user <telegram user id> --charge <charge id> --yes
```

The script refunds the Stars payment and marks the matching Stars subscription canceled.

### PayNow, one time yearly

- [ ] **[Manager]** Refund in the Stripe dashboard like a card payment. There is no renewal, so the `paynow:` subscriptions row runs out by itself; set it to canceled by hand if you want it closed sooner.
