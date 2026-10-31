# Settle - Task cards

Each card is self-contained so it can be pasted into a subagent brief. Format:
- **Deps**: cards that must be merged first.
- **Owns**: the only files/dirs this card may create or edit. Parallel cards never share owned files.
- **Spec**: what to build. Read the referenced ARCHITECTURE section.
- **Done when**: acceptance checks, on top of the global gate (`bun run typecheck && bun run lint && bun test && bun run build`).

Parallel groups (P) can run at the same time once their deps are in.

---

## Day 0 - User setup (human, before any code that needs keys)

**T00-H. Accounts and keys** (user does this, manager checks with a key-presence script, never prints values)
- [ ] BotFather: create bot, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` in `.env`.
- [ ] `ALLOWED_TELEGRAM_IDS`: your numeric ID (+ testers).
- [ ] dev.meta.ai: API key into `MODEL_API_KEY`. Confirm the key works from Singapore (Model API availability varies by country, see `docs/meta-api/models.md`). Manager runs one ~$0.001 smoke call to confirm.
- [ ] Supabase: create project (region Singapore), fill `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`, create private bucket `uploads`.
- [ ] Vercel: account linked to GitHub (deploy only happens in T16 with your go-ahead).
- [ ] Drop real fixtures into `tests/fixtures/real/` (see PRD "Assets the user must provide").

---

## Day 1 - Capture loop

**T01. Scaffold** (sequential, manager may do this itself)
- Deps: none. Owns: everything at repo root except docs/.
- Spec: `git init`; `bunx create-next-app@latest` refuses non-empty dirs, so scaffold into `$TMPDIR/settle-scaffold` with `--ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-bun`, then copy its files in without overwriting `AGENTS.md`, `CLAUDE.md`, `IDEA.md`, `docs/`, `.env`, `.env.example`, and merge `.gitignore` (keep ours); delete the scaffold's `.git` if any; TypeScript strict; install `grammy openai zod @supabase/supabase-js jose sharp ffmpeg-static server-only`; shadcn/ui init; package scripts from AGENTS.md (`typecheck`, `bot:poll`, `eval`); `lib/env.ts` parsing every var in `.env.example` with zod (server-only), throwing a clear error naming the missing var; create the empty folder layout from AGENTS.md; one sample test so `bun test` runs.
- Done when: global gate green; `bun run dev` serves the default page.

**T02. Database** (P1)
- Deps: T01. Owns: `supabase/`, `lib/db/`.
- Spec: migration `supabase/migrations/0001_init.sql` exactly per ARCHITECTURE section 3. `lib/db/client.ts` (server-only singleton with secret key). `lib/db/types.ts` hand-written row types. `lib/db/queries.ts`: `upsertUser`, `markUpdateSeen(updateId): Promise<boolean>`, `createUpload`, `finishUpload`, `listOpenTasks(userId)`, `insertTask`, `updateTask`, `insertTaskEvent`, `insertStarter`, `getStarter`, `upsertWeakSpot`, `createLoginToken`, `consumeLoginToken`, `logAiCall`, `todaysAiSpend`, `countUploadsLastHour`. Unit tests with a mocked supabase client.
- Done when: SQL applies cleanly (manager runs it against the dev project with `SUPABASE_DB_URL`); query tests pass.

**T03. Meta client** (P1)
- Deps: T01. Owns: `lib/meta/client.ts`, `lib/meta/pricing.ts`, `lib/meta/strict-schema.ts`, `tests/meta/`.
- Spec: ARCHITECTURE 4.1. `generateObject` over the Responses API, zod -> JSON schema (`z.toJSONSchema`, then post-process to the strict subset: `additionalProperties:false`, all keys required), `assertStrictSubset()` checker, retries/backoff, timeout via AbortController, usage -> cost, `logAiCall` injected as a dependency (so no DB import), budget guard via injected `getTodaySpend`. Read `docs/meta-api/protocols-responses.md`, `structured-output.md`, `image-understanding.md`, `file-handling.md`, `reasoning.md` before writing. NO live calls: tests mock the `openai` client.
- Done when: tests cover success, invalid JSON then retry success, 429 backoff, budget exceeded, timeout, strict-subset violations.

**T04. Telegram webhook + bot shell** (P1)
- Deps: T01. Owns: `app/api/telegram/route.ts`, `lib/telegram/bot.ts`, `lib/telegram/guards.ts`, `scripts/poll.ts`, `scripts/set-webhook.ts`, `tests/telegram/`.
- Spec: ARCHITECTURE section 2 steps 1-5. `runtime = 'nodejs'`, `maxDuration = 300`. Secret check with `timingSafeEqual`. Dedupe and allowlist via functions injected/imported from `lib/db/queries` (code against the T02 signatures above; if T02 isn't merged yet, import types only and stub in tests). `bot` exported with `botInfo` lazily initialised (`await bot.init()` once). Handlers for `/start` (upsert user, friendly intro), `/help`, and a placeholder `message` handler that replies "Got it" (real pipeline arrives in T06). `scripts/poll.ts`: deleteWebhook then `bot.start()`. `scripts/set-webhook.ts`: sets `${APP_BASE_URL}/api/telegram` with `secret_token`, `allowed_updates: ['message','callback_query']`, refuses to run if `APP_BASE_URL` is localhost.
- Done when: tests: bad secret -> 401; duplicate update -> 200 without handling; non-allowlisted -> refusal reply; good update -> 200 and handler scheduled via `after`.

**T05. Files and media** (P1)
- Deps: T01. Owns: `lib/telegram/files.ts`, `lib/media/normalize.ts`, `lib/media/storage.ts`, `tests/media/`.
- Spec: download by `file_id` via `getFile` (reject > 20 MB with a typed error); normalize images to JPEG, max 2000px long edge, strip EXIF, return `{buffer, width, height}` (dimensions needed later for bbox mapping); PDFs pass through with page-count check if cheap; MIME whitelist; upload to Storage at `{user_id}/{upload_id}/original.{ext}`; `signedUrl(path, 3600)`.
- Done when: tests with small fixture images/PDF generated in-test.

**T06. Understand + reconcile + wiring** (split into three, run 6a and 6b in parallel, then 6c)
- **T06a. Understand prompt + schema** (P2). Deps: T03. Owns: `lib/pipeline/understand.ts`, `lib/meta/prompts/understand.ts`, `lib/pipeline/dates.ts`, `tests/pipeline/understand.test.ts`, `tests/fixtures/understand/*.json`. Spec: ARCHITECTURE 4.2; `dates.ts` builds the `now` context and converts `due_local` (SGT) to UTC; prompt includes Singlish glossary and the date rules; 10+ text fixtures (Singlish messages with expected actions) used both by mocked unit tests and later by `scripts/eval.ts`. Done when: date conversion tests (incl. "next Fri" on a Friday, month rollover) pass; schema passes strict check.
- **T06b. Reconciler + priority** (P2). Deps: T01. Owns: `lib/pipeline/reconcile.ts`, `lib/pipeline/priority.ts`, `tests/pipeline/reconcile.test.ts`, `tests/pipeline/priority.test.ts`. Spec: ARCHITECTURE 4.3 and 4.4, pure functions only. Done when: tests for every branch listed in 4.3 and ordering cases in 4.4.
- **T06c. Ingest wiring** (sequential). Deps: T02, T04, T05, T06a, T06b. Owns: `lib/pipeline/ingest.ts`, `lib/telegram/handlers.ts`, `lib/telegram/replies.ts`; may edit `lib/telegram/bot.ts` to register handlers. Spec: ARCHITECTURE section 2 bot flow for text, photo, document; typing indicator loop; reply summary copy (plain, friendly, no em dashes) with "Open dashboard" URL button (placeholder link until T11); failures per ARCHITECTURE section 6. Done when: an integration test with mocked Meta + mocked DB runs a Singlish "extend" message end to end and asserts one update op and the reply text.

**T07. Eval harness** (P2, manager runs it live)
- Deps: T03. Owns: `scripts/eval.ts`, `tests/fixtures/README.md`.
- Spec: `bun run eval -- understand|math|checklist|flashcards [--limit n]` loads fixtures (`tests/fixtures/<suite>/` and `tests/fixtures/real/`), calls the live API, compares to expected labels, prints pass/fail per fixture, total tokens and USD. Requires `--live` flag to actually call; without it, prints what it would run and estimated cost.
- Done when: dry run works without keys.

Day 1 exit check (manager, live): run `eval understand`; poll-mode bot handles a real screenshot and the Singlish extend flow against the dev DB.

---

## Day 2 - First step done + dashboard

**T08. Starter types + checklist** (P3)
- Deps: T06c. Owns: `lib/starters/types.ts`, `lib/starters/checklist.ts`, `lib/meta/prompts/checklist.ts`, `tests/starters/checklist.test.ts`.
- Spec: ARCHITECTURE 4.5. Write `types.ts` FIRST and report it to the manager, since T09/T10 import it (manager may land types.ts alone before releasing T09/T10). Checklist from PDF input, effort `medium`, page refs. Hook point: export `generateStarterFor(task, upload)` dispatcher in `lib/starters/index.ts` (owned by this card).
- Done when: mocked tests; strict schema check passes.

**T09. Flashcards + practice** (P3)
- Deps: T08 types. Owns: `lib/starters/flashcards.ts`, `lib/meta/prompts/flashcards.ts`, `tests/starters/flashcards.test.ts`.
- Done when: mocked tests; 10-20 cards enforced by schema min/max (if supported, else post-validate).

**T10. Math diagnosis + annotated photo** (P3, the killer feature)
- Deps: T08 types, T05. Owns: `lib/starters/math.ts`, `lib/meta/prompts/math.ts`, `lib/starters/math-topics.ts`, `lib/media/annotate.ts`, `tests/starters/math.test.ts`, `tests/media/annotate.test.ts`.
- Spec: ARCHITECTURE 4.5 MathDiagnosis + annotation. Effort `high`, timeout 200s. Caption (if any) is treated as the expected answer. Prompt: transcribe steps first, verify each step independently, the first step whose output doesn't follow from the previous is the error (not the first step whose value differs from a model solution); bbox per step. Annotation maps 0-1000 bbox to the normalized image's pixel size. Reply: annotated photo + short caption: "Step 3 is where it slipped: ...". Read `docs/meta-api/image-understanding.md` "perception grounding" first.
- Done when: bbox mapping tests (corners, clamping); annotate produces an image of the same size; mocked diagnosis flows to a reply.

**T11. Dashboard auth** (P3)
- Deps: T02, T04. Owns: `app/auth/[token]/route.ts`, `lib/auth/`, `middleware.ts`, `tests/auth/`; may add the `/dashboard` command in `lib/telegram/handlers.ts` (coordinate: manager serialises edits to that file).
- Spec: ARCHITECTURE 5 magic link + session. `/dashboard` replies with a single-use link. Invalid/expired/used token -> friendly page telling the student to send /dashboard again.
- Done when: tests for issue, consume once, expiry, reuse rejected, middleware redirect.

**T12. Dashboard UI in Direction C** (P3, revised)
- Deps: T02 (types), T08 types, T18a (design foundation). Owns: `app/(dashboard)/`, `components/dashboard/`. Primitives come from `components/settle/` (owned by T18a; ask the manager if one is missing).
- Visual source of truth: `docs/design/C-study-loud.html` (Dashboard toggle) and `docs/design/shots/C-study-loud-dash.png`. Directions A and B are rejected.
- Spec: PRD F5 data and behaviour. Server components fetch via `lib/db/queries` scoped to the session user (`getSessionUser()` from `lib/auth`, stub if T11 not merged). Layout is the mock's `#dash` view:
  - "Next up" = the single highest-priority open task (`lib/pipeline/priority.ts`) as a lime `Chunk`, with start and later actions.
  - "This week" list: each task is a `Chunk` row with `Check`, title, a due line and a sticker for its kind or status. A task moved by the reconciler shows a "moved" sticker and its evidence quote from `task_events`.
  - Task detail renders the starter by type: checklist (server action updating `starters.content`), flashcards (`FlipCard` plus Again/Hard/Got it, local state only for now), math diagnosis (annotated image via signed URL, numbered `Tex` steps, wrong step ringed in destructive, misconception, practice with reveal).
  - Weak spots panel: one row per topic, occurrences as segment pips, "recurring" at 3 or more.
  - Header nav: Tasks / Study / Weak spots. Drop "Study" if the route does not exist by Day 3.
  - Plan-aware but inert: read `getPlanForUser()` from `lib/billing` (T19). With billing disabled it returns `pro`, so nothing is locked. No upgrade prompts in this card, except the read-only "Plan" card described in T19.
- Mobile first: under 768px one column in the order Next up, This week, Quick study, Weak spots. Tap targets at least 44px.
- Done when: build green; manager screenshots at 390px and 1440px with seeded data, compared with `docs/design/shots/C-study-loud-dash.png`.

**T18a. Design foundation: Direction C tokens, primitives, plan config** (sequential, lands before T18 and T12)
- Deps: T01. Owns: `app/globals.css`, `app/layout.tsx`, `components/settle/`, `components/ui/button.tsx`, `lib/billing/plans.ts`, `lib/billing/flags.ts`, `tests/billing/`, `tests/settle/`.
- Spec: tokens, fonts and primitives exactly as in `docs/design/MANAGER-BRIEF.md` section 1 (Unbounded, Geist, Geist Mono, Caveat; `Chunk`, `Sticker`, `Check`, `FlipCard`, `Tex`, and a `chunk` Button variant). `lib/billing/plans.ts` is the single source for plan names, prices and bullets (section 2, T19, values decided in section 4). `lib/billing/flags.ts` exports `isBillingEnabled()` reading `process.env.BILLING_ENABLED === "true"` directly (never through the full env parse, so the public landing page cannot break on an unrelated missing variable).
- Done when: global gate green; a component test per primitive (variants, keyboard flip, reduced motion, `Check` accessibility); plans tests (shape, prices as `S$7.99` / `S$63.99`, yearly discount about 33%, fair-use caps, `anchor` nullable).

**T18. Landing page in Direction C** (P3)
- Deps: T18a. Owns: `app/page.tsx`, `components/marketing/`.
- Visual source of truth: `docs/design/C-study-loud.html` (Landing toggle) and `docs/design/shots/C-study-loud.png`.
- Spec: sections in order: pill nav, hero with the stacked chat-to-week cards, "Every task comes pre-started" bento (math photo large, flashcards, checklist), pricing, dark loop CTA, footer. CTAs link to `https://t.me/${TELEGRAM_BOT_USERNAME}` (read `process.env.TELEGRAM_BOT_USERNAME` directly, not through the full env parse). Nav links only to sections that exist (How it works, Pricing); the mock's "For tutors" link is dropped because teacher accounts are a PRD non-goal. Pricing renders only from `lib/billing/plans.ts` (no numbers in JSX), monthly/yearly toggle, Pro button reads "Coming soon" and is disabled while billing is off, the payment line is hidden. Real `title` and `description` metadata. Mobile first: at 390px the hero cards stop overlapping (chat card on top, task card below with a small offset).
- Done when: global gate green; manager screenshots at 390px and 1440px compared with the mock; a test that the pricing section renders from config.

**T19. Billing seams (hackathon, flag off)** (P4-ish, after T18a)
- Deps: T02, T06c, T18a (plans.ts already landed there). Owns: `lib/billing/entitlements.ts`, `supabase/migrations/0002_billing.sql`, `tests/billing/`. The manager adds `BILLING_ENABLED` to env (done). Spec in `docs/design/MANAGER-BRIEF.md` section 2, T19: `subscriptions`, `usage_events`, `billing_events` tables, SQL function `claim_usage` with an advisory lock, `getPlanForUser`, `claimFeature` / `consumeUsage` / `releaseUsage`, pure `periodStart(now)` in Asia/Singapore, gate order (understand always runs, then claim, then the AI call, then consume or release; a failed AI call never uses quota), quota-hit reply wording in one exported constant (states the limit, points to `/dashboard`, no price, no buy or upgrade button inside Telegram).
- Do NOT apply `0002_billing.sql` to Supabase without the user's go-ahead.
- Done when: tests for quota allowed/hit, fair-use cap, concurrent claim, release on failure, retry idempotency, billing disabled means everyone is pro.

Day 2 exit check (manager, live): `eval math` on real photos (target 4/5 correct step), checklist and flashcards on one real PDF each, dashboard walkthrough on phone.

---

## Day 3 - Loop, hardening, demo

**T13. Weak-spot loop** (P4)
- Deps: T10, T12. Owns: `lib/weakspots/`, `app/(dashboard)/weak-spots/`, `tests/weakspots/`; may edit `lib/starters/math.ts` only to call `recordWeakSpot`.
- Spec: PRD F4. Pure `scheduleReview(occurrences, now)`; `recordWeakSpot` upserts, creates the review task (origin `weak_spot`, kind `review`) with a `review_practice` starter from the diagnosis practice questions; bot reply mentions "I've added a review for Fri so this sticks."
- Done when: scheduling tests; mocked end-to-end from diagnosis to review task.

**T14. Voice notes** (P4)
- Deps: T03, T06c. Owns: `lib/media/audio.ts`, `lib/meta/transcribe.ts`, `tests/media/audio.test.ts`; may add the voice handler to `lib/telegram/handlers.ts` (manager serialises).
- Spec: ARCHITECTURE 4.6. Read `docs/meta-api/speech-to-text.md`. Log audio seconds + cost to `ai_calls`. Reply quotes the transcript briefly so the student sees it was heard right.
- Done when: conversion test on a generated tone OGG; mocked transcribe flow.

**T15. Hardening** (P4)
- Deps: T06c. Owns: `lib/telegram/limits.ts`, `tests/hardening/`; edits to handlers via manager.
- Spec: per-user rate limit, budget-exceeded reply, unsupported file reply, garbled image path, `/tasks` and `/done <n>`, low-confidence clarification with inline keyboard (callback updates the chosen task). Error copy reviewed for tone.
- Done when: tests for each path.

**T16. Deploy** (manager + user, needs explicit go-ahead)
- Push to GitHub (user approves), Vercel project, env vars set in Vercel, production Supabase = dev project unless user wants separate, `bun run scripts/set-webhook.ts` against the Vercel URL, smoke test from phone.

**T17. Demo kit** (P4)
- Deps: T13. Owns: `scripts/seed-demo.ts`, `docs/DEMO.md`, `README.md`.
- Spec: seed a demo user with realistic tasks/history so the dashboard looks lived-in; `docs/DEMO.md` shot list matching PRD demo script with exact inputs to send; README for judges (problem, what it does, Meta models used and how, architecture diagram in text, setup). Plain human copy, no em dashes.

---

## Post-hackathon (written now, do not start)

**T20. Telegram Stars subscription (bot).** Required before public launch: anything sold on the website must also be buyable with Stars in the bot. Stars price decided by the user at that point. `createInvoiceLink` with `currency: "XTR"`, empty `provider_token`, `subscription_period: 2592000`. Handle `pre_checkout_query` (answer within 10s) and `successful_payment`; upsert `subscriptions` (`provider='stars'`, `provider_ref=telegram_payment_charge_id`, `current_period_end` from `subscription_expiration_date`). Add `/paysupport` and `refundStarPayment`. Add `pre_checkout_query` to `allowed_updates` in `scripts/set-webhook.ts`, then re-run it with the user's go-ahead.

**T21. Stripe on the web.** Dashboard-only (`/billing`). Checkout Session created per logged-in user (`client_reference_id = user.id`, metadata `user_id`); Customer Portal for cancel/update. Webhook route verifies the signature on the raw body, dedupes via `billing_events`, handles `checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.payment_failed`, upserts `subscriptions` (`provider='stripe'`). Route stays a thin wrapper; logic in `lib/billing/stripe.ts`. PayNow only for the yearly plan as a one-time charge.

**T23. Log in with Telegram (web).** Telegram Login Widget, keyed only on the immutable Telegram user id. Same account as the bot. Built before T22.

**T22a. Launch ops (code, no legal text).** Allowlist off switch `ALLOWLIST_ENABLED` (default on; refuses to open while `BILLING_ENABLED=false` because billing off means everyone is Pro with unlimited AI cost), per-user daily upload cap in `limits.ts`, `scripts/stats.ts` (read-only numbers for the presentation: users, uploads, tasks, AI spend, subscriptions by provider), `scripts/smoke.ts <base url>` (health, landing, protected redirects, webhook 401/405, stripe webhook 400/503, legal pages warn-if-missing), `docs/LAUNCH.md` (ordered checklist with owners and rollback), dashboard lock-state upgrade banner pointing to `/billing`, strip the traced `typescript` from the image.

**T22b. Consent before account creation and payment.** Found by the legal review: `/start` and the first message currently create a user row before any terms or privacy step. Add affirmative acceptance before account creation and before payment. Telegram: a consent message with URL buttons to the policies and an `I agree and continue` button; the user row is created only on that tap, storing `terms_accepted_at` and `terms_version` (migration `0004`); existing users without a current acceptance get the same prompt on their next message and the message is not processed (asked to resend). Web: after a verified Telegram login for an unaccepted or missing user, a short-lived signed cookie carries the verified id to an `/accept` page; the user row and session are created only on its confirm. `/pro` invoices and Stripe checkout require current acceptance. All consent wording lives in one file for counsel to edit; legal page text is written separately (the user's other agent) and reviewed by Singapore counsel, especially the minor-user and liability language.

**T22c. Launch switch (user go-ahead + Telegram heads-up).** `BILLING_ENABLED=true`, `ALLOWLIST_ENABLED=false`, `set-webhook` re-run (message, callback_query, pre_checkout_query), BotFather `/setdomain`, Stripe live keys, launch smoke test. Not done by the manager without the user's go.
