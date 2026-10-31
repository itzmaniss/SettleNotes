# Settle - Progress log

Newest entry on top. Each entry: date, card(s), commit(s), gate result, live spend, decisions, next steps.

## 2026-10-31 - T21 Stripe (test mode), T23 web login with Telegram
- T21 (`72b4c3e`): `/billing` page (protected; Free with usage, monthly S$7.99 / yearly S$63.99 from `plans.ts`, optional PayNow-for-a-year, Manage subscription via Customer Portal, "Test mode, no real charges" sticker for `sk_test_` keys, banners for success/canceled/error), Checkout per logged-in user (`client_reference_id` and metadata come from the session, never the form), signed Stripe webhook at `/api/stripe/webhook` (raw body, `constructEvent`, dedupe in `billing_events` as `stripe:<event id>`, marker removed on failure so Stripe retries, 503 unconfigured, 400 bad signature) handling `checkout.session.completed`, `customer.subscription.updated|deleted`, `invoice.payment_failed`. Unknown Stripe statuses map to canceled (never unlock Pro). PayNow = one-time charge buying 365 days. SDK facts: stripe 23.1.0 keeps the period end on subscription items; PayNow filter is `allowed_payment_method_types`. Web nudge only on the website; the bot never mentions it (Telegram policy). All five Stripe env vars are optional, so a deploy without them still starts. Needs from the user: Stripe account, products and prices in test mode, webhook endpoint, five env values in the server env file.
- T23 (`651bb2a`): Telegram Login Widget at `/login`, route `/auth/telegram`. HMAC check (secret = SHA256(bot token), sorted data-check-string, constant-time compare), 5 minute replay window, unknown or repeated fields rejected, `next` limited to same-site prefixes. Identity is the numeric Telegram id only (usernames are never used). New web-first rows get chat id = telegram id (the bot cannot message them until they send /start). Same allowlist rule as the bot. Needs from the user: BotFather `/setdomain` with the bare production domain; works only on the https domain.
- Manager findings: `next build` failed after T21 even though typecheck, lint and 1236 tests were green: a client component (`pricing-section.tsx`) imported a text constant from a module that reached the server-only database layer. Fixed by moving the constant to a dependency-free `lib/billing/web-copy.ts`, and added `tests/deploy/client-boundary.test.ts` (walks every client component's import graph; proven to catch the original chain). My own slip, disclosed: while proving that, I ran `git checkout` on `pricing-section.tsx` and discarded T21's two uncommitted edits to it; recovered exactly from the agent transcript and re-verified by diff. Lesson: never use `git checkout --` on a tree with uncommitted agent work; use a file copy.
- Gate: typecheck, lint, 1247 tests, build green.

## 2026-10-31 - T16 container deploy, T20 Telegram Stars (nothing live)
- Direction from the user: production is a VPS with Docker and their own domain (Vercel Hobby is non-commercial, so `settlenotes.vercel.app` stays a demo); the image must be as slim as possible; the public presentation should be open to anyone with real subscriptions; Stripe in TEST mode first (the user adds keys to the server env file themselves); Stars price 600 per month; log in with Telegram on the web.
- T16 (`be3611c`): `Dockerfile` (oven/bun alpine builder, node:22-alpine runner, Next standalone behind `NEXT_OUTPUT=standalone`, non-root uid 1001, three COPYs only, no secrets or ARGs, healthcheck), `.dockerignore`, `GET /api/health`, `deploy/docker-compose.yml` + `deploy/Caddyfile` (Caddy for automatic HTTPS), `docs/DEPLOY.md`. Manager built the image for linux/amd64 with Apple `container` and ran it with NO env vars: ffmpeg-static 7.0.2 (static) runs on Alpine, sharp loads, `/api/health` 200, landing 200, `/dashboard` without a session redirects. Size about 121 MB compressed (168 MB unpacked); ffmpeg is 77 MB of it (needed for voice), @img/sharp 37, next 30. Possible later saving: strip the traced `typescript` (9 MB).
- T20 (`99a773b`): Stars subscription for Pro. `/pro` (invoice link with one `Pay with Stars` button; says "not on sale yet" while billing is off), `/paysupport` (7 day refund window constant, the user confirms policy in T22), `pre_checkout_query` always answered within seconds (validated: currency XTR, amount from plans.ts, payload user must be the payer), `successful_payment` deduped through `billing_events` and extends one Stars row on renewals, `scripts/refund-stars.ts` (dry run by default). Pro `price.stars` is now 600 in `plans.ts`. Found and fixed: the webhook route silently dropped all `pre_checkout_query` updates (sender id was only read from message/callback); strangers get a refusal answer. The bot says nothing about the website or other payment routes (Telegram policy); nudging toward web payment lives on the website only. `TELEGRAM_ALLOWED_UPDATES` now has message, callback_query and pre_checkout_query: the webhook must be re-registered with `set-webhook.ts` (needs the user's go-ahead) for payments to arrive.
- Gate at this point: typecheck, lint, 1121 tests, build green.
- Note: the allowlist has no off switch (an empty list admits nobody); T22 must add one before opening the bot to the public, and billing must be ON first because with `BILLING_ENABLED=false` everyone counts as Pro.

## 2026-10-31 - T15b clarification buttons, 0003 applied
- T15b: low-confidence actions (confidence < 0.5) are parked in `pending_actions` and shown as Yes/No inline buttons (create: `I think this is a new task: "<title>", due ... Add it?`; update: `Should I move "<title>" to ...?` / `Should I update ...?`; complete: `Did you finish "<title>"?`). A tap claims the row atomically (`status='pending' and expires_at > now() and user_id=...`), then applies through the same `executeOps` as the confident path so task_events match; a failed apply hands the row back to pending; rows expire after 1 day. Unresolvable targets, missing titles and anything past 3 prompts per message fall back to the old text-only line. A failure to store a pending row never loses the task writes. `TELEGRAM_ALLOWED_UPDATES` (message + callback_query) is now one tested constant used by `set-webhook.ts` and `poll.ts`; the webhook route and guards already handled callback updates (dedupe is by update_id).
- Migration `0003_pending_actions.sql` validated on a throwaway local Postgres 17 (all three migrations apply; 20 simultaneous taps on one row produced exactly 1 claim; another user and an expired row claim nothing; check constraints reject bad values; task delete cascades), then applied to Supabase on the user's go-ahead: 13 public tables, RLS on, 0 policies, 0 rows.
- Gate: typecheck, lint, 1030 tests, build green. Not yet run against live Telegram (needs a real chat with a low-confidence message).
- Known limit: a pending row stored just before a budget error can be orphaned until it expires (student never saw buttons).
- Deploy note: the user deployed `settlenotes.vercel.app` (Vercel, GitHub auto-deploy on push, Singapore region). Landing page and the webhook secret check respond correctly from outside; which Supabase project that deploy uses is unconfirmed (the Supabase integration may have injected its own project and variable names). The webhook is NOT registered. Production will be self-hosted (Vercel Hobby is non-commercial), so T16 becomes a Dockerfile plus runbook. Every push to `main` now redeploys the Vercel demo.

## 2026-10-31 - T15a hardening, 0002 applied, first big push
- Done on the user's explicit "go": `0002_billing.sql` applied to Supabase in one transaction (12 public tables, RLS on all, 0 policies, `anon`/`authenticated` cannot execute `claim_usage`; a limit-0 rpc call through the API returned null and wrote nothing). `BILLING_ENABLED` still false. `main` pushed to origin (`4cf1431..3f55c12`, 17 commits) after a full-history scan for the real `.env` values and key-shaped strings (zero hits). Tags `day1-final`/`day2-final` NOT pushed. No Telegram heads-up was sent (no Telegram tool in the session).
- T15a: per-user rate limit (8 ingesting messages per 60 s, counted from `uploads`, so it works serverless; fails open), `/tasks` (top 5, same ranking as the dashboard) and `/done <n>` (resolves n against the same cut, same write shape as a chat completion, scoped by user id), `pdfUnreadableReply`, and `aiBusyReply` so a Meta timeout or outage no longer tells the student to send a clearer photo. Tests in `tests/hardening/` for every error path plus a dash and engineer-jargon scan over all fixed replies. Gate: typecheck, lint, 968 tests, build green.
- Process note: the GLM subagent died at ~80% with `HTTP 429: Weekly/Monthly Limit Exhausted` (resets 17:26 today). Partial output was reviewed and was good; with the user's one-off approval the manager fixed two bad test expectations (a hard-coded wrong date; the known-commands registry test), added the error-path/tone tests and `aiBusyReply`, and committed. All other work stays delegated.
- Deferred, needs a decision: T15b, the low-confidence "did you mean?" inline buttons (needs a `pending_actions` table = migration `0003`, or a limited stateless version for moves and ticks only). T16 deploy needs a host choice.

## 2026-10-31 - T14 voice notes, T17 demo kit
- Commits (local): `b2db3bc` T14; `be8696a` T17. Gate: typecheck, lint, 893 tests, build green.
- T14: OGG to WAV 16 kHz mono via ffmpeg-static (real conversion test on a generated Opus tone), `muse-voice-transcribe-1.0` client with retries, budget guard and per-call cost logging, voice handler (notes over 3 minutes refused before download). Reply starts with `I heard: "..."`, then the normal reply; the transcript goes through the same Understand flow, so Singlish deadline moves work from voice. Not gated by the usage ledger.
- Manager fix: the brief and ARCHITECTURE 4.6 said `languageBias: ["en"]`, but the speech-to-text doc specifies language names, so it is now `["English"]` (code, test, README, ARCHITECTURE). Not yet confirmed against the live API: the first real voice note is the test.
- T17: `scripts/seed-demo.ts` (dry run by default, `--yes` to write, `--reset` removes only marker-tagged demo rows, refuses ids outside ALLOWED_TELEGRAM_IDS), `docs/DEMO.md` shot list, `README.md` for judges. Dry run verified by the manager; the write path has NOT been run yet (needs a supervised `--reset --yes` before recording). README quotes 893 tests and makes no math accuracy claim.
- Not done: live voice check, seed write run, README/DEMO need a final read once real fixtures exist (`tests/fixtures/real/` does not exist yet).

## 2026-10-31 - Checkpoints

Local git tags (not pushed; `git push origin --tags` would publish them):
- `day1-final` = `d10a522` "fix: eval matcher ignores unlisted fields; clarify heavy-singlish fixture". Capture loop: T01-T07 plus T06c, live `eval understand` 13/13. (The landing page and design foundation T18/T18a, `319d9dd` to `4cf1431`, were a separate track done right after.)
- `day2-final` = `2f33d24` "docs: progress log for Day 2 cards". T08-T12 (starters, auth, dashboard), T12b polish, T08w wiring.
- Later work (T13 weak spots, T19a/b billing seams, `f24c907` onward) is Day 3 / post-hackathon prep.

Roll back to look at a checkpoint without disturbing current work: `git worktree add ../Settle-day1 day1-final` (then `cd ../Settle-day1 && bun install`). Remove with `git worktree remove ../Settle-day1`. Plain `git checkout day2-final` also works on a clean tree; return with `git checkout main`.

## 2026-10-31 - T13 weak-spot loop, T19a/T19b billing seams
- Commits (local): `f24c907` T13; `18d9d7a` T19a; T19b committed after this entry. Gate: typecheck, lint, 834 tests, build all green. Also ran the whole suite with `SUPABASE_URL` pointed at a dead address: all 834 still pass and nothing tries to connect, so no test touches the real DB.
- T13: `scheduleReview` (1st +3 days, 2nd and later +1 day, 3rd+ flagged recurring), due at 23:59 SGT of the target day. `recordWeakSpot` upserts the weak spot, sets next review, and creates ONE open `review` task per weak spot (reschedules instead of duplicating, with an 'updated' event) plus a fresh `review_practice` starter each time. Reply sentences: 1st "I've added a review for <weekday> so this sticks.", 2nd "...for tomorrow so this sticks.", 3rd+ "This one keeps coming up, so I've added a quick review for tomorrow." Wired as the default `onDiagnosisRecorded` in `createStartersDeps`. `/weak-spots` page built (nav no longer 404s).
- T19a: `supabase/migrations/0002_billing.sql` (subscriptions, usage_events, billing_events, `claim_usage` with a per-user advisory lock, RLS on, no policies), `lib/billing/{queries,entitlements,copy}.ts`. NOT applied to Supabase. Validated on a throwaway local Postgres 17 (scratch dir, port 54399, deleted afterwards): both migrations apply, 20 parallel claims against limit 3 granted exactly 3, same-upload retry is idempotent, a released claim frees the slot, last month's rows do not count, constraints reject bad values. (My first two runs of that harness were wrong: a uuid/text type mix and a period start in the future. The SQL was not at fault.)
- Known edge, not fixed: a released claim re-claimed by the SAME upload skips the limit re-check; only matters if another upload took the freed slot first and the original is retried. Telegram retries are already deduplicated at the webhook.
- T19b: the gate sits in front of the three starter AI calls (brief checklist, slides flashcards, math diagnosis). Claim before the call, consume after a usable result, release on throw/empty/too-thin/unreadable. Understand and every task write are never gated. Refused math photo: no task, whole reply is the quota text. Refused brief/slides: task still created, quota sentence appended. FAIL OPEN: if the claim throws (e.g. the migration is not applied), one log line and the bot carries on. No price, upgrade or buy wording in any Telegram reply. A Plan card (disabled "Coming soon" button, no prices, fair-use caps hidden) shows on /dashboard only when `BILLING_ENABLED=true`.
- Deviation: T19b edited `tests/weakspots/e2e.test.ts` (3 lines of billing fakes) because the real default claim reached the real Supabase from a test and polluted the cached env for other tests. Accepted.
- Until `0002` is applied and `BILLING_ENABLED` is flipped, usage is not recorded (every claim fails open with a log line).

### Next
1. User go-ahead to apply `0002_billing.sql` to Supabase (same single-transaction procedure as 0001), then optionally flip `BILLING_ENABLED` only at launch (T22).
2. T14 voice, T15 hardening, T17 demo kit need no fixtures. Day 1 live check and Day 2 live evals need the user's screenshots, math photos, a brief PDF and a slides PDF.
3. Push when the user says so (last push was `4cf1431`).

## 2026-10-31 - Day 2: T08-T12 built, starters wired into the bot
- Commits (local): `2a62a9e` T08 starter schemas + checklist + dispatcher; `b96cf18` T11 dashboard magic-link auth; `93cc0de` T09 flashcards; `9504520` T10 math diagnosis + annotated photo; `f0db6dc` T12 dashboard UI (Direction C); `5742ae4` T12b polish; `b834123` T08w starter wiring. Gate at the end: typecheck, lint, 693 tests, build all green. Pushed to `origin/main` only up to `4cf1431`; everything after is local. Ask before the next push.
- Subagent stall: the first attempt at T09, T10 and T12 in parallel hung 12 to 13 minutes waiting for model replies (all three at once) and was interrupted; nothing was written. A lone T09 canary then ran normally, then T10 + T12 in parallel worked. Likely a provider hiccup, not confirmed. If it recurs: send one small card first, and consider the delegation model.
- Decisions:
  - Bbox is an object `{x1,y1,x2,y2}` on the 0-1000 grid (strict mode does not document tuples or minItems). Flashcard limits (10-20 cards, 3-5 practice) are enforced in code, not in the wire schema.
  - Login link sent with link previews disabled so Telegram's fetcher cannot burn the single-use URL. Session cookie: jose HS256, HttpOnly, SameSite=Lax, `Secure` only when `APP_BASE_URL` is https. Protected prefixes `/dashboard`, `/tasks`, `/weak-spots` (middleware, fails closed).
  - Starters: checklist attaches to the first created (else first updated) task from an assignment brief PDF. Slides PDF with no resulting task gets a fallback "Revise: <filename>" reading task so flashcards have a home. Math photo: wrong working creates a `math_practice` task "Math check: <topic>" with a `math_diagnosis` starter and the annotated JPEG; correct or unreadable working writes nothing. Starter failures never lose the task (reply gets one plain sentence); a math model failure fails the upload with no task written.
  - Maths in stored text uses `$...$` for inline LaTeX (prompts say so; `MixedMath` renders it); `steps[].latex_or_text` stays raw LaTeX.
  - Manager small fixes: task page and actions require real UUIDs (bad id is a 404, not an error page); `tests/starters/index.test.ts` updated for the flashcards registration.
- Manager visual check with seeded data (labelled user "ZZ Demo Seed", deleted afterwards, DB and storage verified empty): real magic-link login works, checklist tick persists, no horizontal overflow at 390px, T12b defects fixed (done tasks, spaced plain text, weak-spot wrapping).
- Follow-ups: the "This week" heading sits over the Overdue and Later groups (label only); `/weak-spots` 404s until T13 (nav links to it); no Later action; the `/dashboard` empty-state copy assumes the bot link exists; Lighthouse not run; a `next-server` for this repo has been running on port 3000 for hours and was not started by the manager (left alone).
- Not built yet: T13 weak-spot loop (the `onDiagnosisRecorded` hook is in place), T14 voice, T15 hardening, T19 billing seams (`plans.ts` exists), T16 deploy, T17 demo kit. Day 1 live check and the Day 2 live evals (`eval math` on real photos, checklist and flashcards on real PDFs) still need the user's fixtures; no live spend since the 13-fixture understand eval.

### Next
1. Day 1 exit check with the user's screenshots via `bun run bot:poll`.
2. Day 2 live evals once real fixtures exist (math photos with labelled wrong step, one brief PDF, one slides PDF); wire `eval math|checklist|flashcards` runners into `scripts/eval.ts`.
3. T13 weak-spot loop, T19 billing seams, then T14, T15, T17; T16 deploy needs the user's go-ahead.

## 2026-10-31 - Remote set up, first push
- `origin` = `git@github.com:itzmaniss/SettleNotes.git` (SSH; HTTPS has no stored credentials on this Mac, the `~/.ssh/github` key authenticates as `itzmaniss`). The repo is PUBLIC and was empty. Pushed `main` up to `4cf1431` on the user's explicit request after a secret scan of the full history (only fake test values and doc examples matched).
- Commits carry the user's git identity (name and Outlook email from `git config`), so that email is now public in the repo history.
- The standing rule "manager never pushes" is overridden only for pushes the user asks for. Ask before each later push.
- Day 2 started: T08 (starter schemas + checklist + dispatcher) and T11 (dashboard auth) dispatched in parallel.

## 2026-10-30 - Website: Direction C design foundation (T18a) + landing page (T18)
- User picked Direction C ("Study Loud") from `docs/design/`; brief saved as `docs/design/MANAGER-BRIEF.md`. TASKS.md now has T12 revised (Direction C), T18a, T18, T19 (billing seams, not built), and T20-T22 (post-hackathon, do not start).
- Manager prep (`319d9dd`): `katex` + `@types/katex`; `BILLING_ENABLED` env flag (default false, tested); design docs committed.
- `da7fef2` T18a: tokens (light only), fonts (Unbounded, Geist, Geist Mono, Caveat), primitives in `components/settle/` (Chunk, ChunkButton via Button `variant="chunk"` + `tone`, Sticker, Check, FlipCard, Tex), `lib/billing/plans.ts` (S$7.99 / S$63.99, free quotas 3 math / 1 deck / 1 brief, Pro fair-use caps), `lib/billing/flags.ts`. Tone variants win over the card default through cva with no `!important` (fixes the mock's white-on-white CTA).
- T18 landing page: `app/page.tsx` + `components/marketing/` + 15 tests. Gate: 387 tests, build green, `/` is static. Pricing renders only from `plans.ts` (manager grep found no price literals in components/marketing). Pro button is disabled "Coming soon" while billing is off. CTAs link to `https://t.me/<TELEGRAM_BOT_USERNAME>` read straight from `process.env`; if unset they degrade to a disabled "Bot link coming soon" button, and the page prerenders with zero env.
- Manager visual check: production build served on a scratch port, headless Chrome at 1440px and a true 390px viewport. Matches the mock (fonts loaded, lime/ink tones correct, no overlaps). Mobile hero stacks with a small offset. Lighthouse not run yet.
- Deviations from the mock: "For tutors" link dropped (teacher accounts are a PRD non-goal); compact "How it works" strip added so the nav link has a target; the Pro anchor sticker uses the config text "Less than a McSpicy meal."; Check uses an 8px radius (token radius made the 24px box a circle); chat card background is the literal `#dbe7f2` (no token for it).
- Not built (by design): billing logic and `0002_billing.sql` (T19), dashboard UI (T12), terms/privacy/refund pages (T22; footer has no links to them yet).
- Landing needs a public URL to be seen by anyone else: T16 deploy still needs the user's go-ahead. Set `TELEGRAM_BOT_USERNAME` in Vercel so the CTAs work.

### Next
1. Day 1 exit check with real screenshots (waiting on the user's friends).
2. Day 2: T08 types, then T09 and T10 in parallel, T11, T12 (Direction C), T19.

## 2026-10-30 - T06c ingest wiring + first live eval
- T06c done (`a6feb5d`): `lib/meta/index.ts` (lazy Meta client), `lib/pipeline/execute.ts` (op executor), `lib/pipeline/ingest.ts`, `lib/telegram/replies.ts`, `lib/telegram/handlers.ts` (text/photo/document/catch-all), `bot.ts` registers them. 306 tests, build green.
- Bot-level allowlist middleware added as the first `bot.use` so `bun run bot:poll` is also gated by `ALLOWED_TELEGRAM_IDS` (poll mode skips the webhook route's guards).
- Dashboard button only attaches when `APP_BASE_URL` is https and not localhost (Telegram rejects localhost button URLs). Locally replies go without a button.
- Live eval `bun run eval -- understand --live`, three runs: first 3/13 (harness bug), then 12/13, final 13/13. Cost per run about $0.04-0.05 (13 calls, ~19k input tokens of which ~17k cached, ~8k output). Total live spend so far about $0.13.
  - Harness bug fixed by the manager: `scripts/eval-match.ts` compared fixture fields it did not list against null, so correct answers failed. Now only listed fields are checked; explicit null still means must-be-null (regression test added).
  - Fixture change: `singlish-filler-heavy` had an open task "SC2211 Lab Report" next to a message about "proj report", so the model correctly asked a clarifying question. Changed the open task to an unrelated "MA2001 Tutorial 5". Intent of the fixture (Singlish filler, "this Wed" said on a Friday) unchanged.
  - Prompt caching works: about 90% of input tokens cached after the first call.
- Left for later cards: math diagnosis behind `onMathWorking` (T10), starters on created tasks (T08, T09), real dashboard link (T11), rate limits and `/tasks` (T15), voice (T14).
- Not yet done: poll-mode bot run against the dev DB with a real screenshot and the Singlish extend flow (rest of the Day 1 exit check).

### Next
1. Day 1 exit check: `bun run bot:poll` (long polling, uses dev DB, spends a few cents), send a real chat screenshot and "prof say extend lab 4 to nxt fri liao" from an allowlisted Telegram account. Needs the user at the phone.
2. Day 2: T08 types first, then T09 and T10 in parallel, T11, T12.

## 2026-10-30 - Migration applied + group P2 (T06a, T06b, T07)
- Migration `0001_init.sql` applied (single transaction) to the Supabase project in `SUPABASE_DB_URL`: it was an empty Postgres 17 with no public tables. Result: 9 tables, RLS on for all, 0 policies. Applied with explicit user go-ahead. No Telegram heads-up was sent (no Telegram tool in the manager session).
- Storage bucket `uploads` does NOT exist yet (T00-H item, not created by the manager). Needed for the Day 1 live check.
- Gate after P2: typecheck, lint, 250 tests, build all green. Eval dry run (`bun run eval -- understand`) lists 13 fixtures, est. $0.13, no keys needed.
- Commits (local, not pushed): T06a understand prompt/schema/dates/13 fixtures, T06b reconcile + priority (51 tests), T07 eval harness (40 tests). Hashes in `git log`.
- Decisions:
  - `ReconcileAction` (T06b) takes `taskId` and `dueAt` already resolved by the caller. T06c must map `task_ref` via `refToTaskId` (unknown ref -> `taskId: null`) and convert `due_local` with `dueLocalToUtc` before calling `planReconcile`.
  - `planReconcile` returns ops only; the DB executor (`executeOps`) is T06c's job. Op kinds: `create`, `update`, `complete`, `clarify`.
  - Complete with an unknown id is dropped, never downgraded to a create.
  - `priority.ts` also exports `bucketOf` / `groupByBucket` (overdue/today/this_week/later, SGT, Monday-start weeks) for T12.
  - `understand()` clamps confidence to 0..1 in code (strict mode has no min/max). It does not convert `due_local`.
  - Eval harness: dry run by default, `--live` needed to spend, `--max-usd` default 2; live runner uses in-memory cost tracking (no DB). math/checklist/flashcards runners are null until T08-T10; the manager wires them into `scripts/eval.ts`.
- Live spend so far: about $0.0005.

### Next
1. User creates private bucket `uploads` (or asks the manager to).
2. T06c ingest wiring (owns `lib/pipeline/ingest.ts`, `lib/telegram/handlers.ts`, `lib/telegram/replies.ts`, may edit `lib/telegram/bot.ts`; also needs an app-level Meta client wiring file, e.g. `lib/meta/index.ts`, plus `executeOps`).
3. Live: `bun run eval -- understand --live` (about $0.15), then the poll-mode bot against the dev DB.

## 2026-10-30 - Day 1: Meta smoke call, T01, group P1 (T02-T05)
- Session start: all `.env` keys present (not printed). Meta smoke call OK: `muse-spark-1.3`, HTTP 200, 119 tokens (about $0.0005). Key works from Singapore.
- Gate after P1: `typecheck`, `lint`, `bun test` (120 pass), `build` all green.
- Commits (local, not pushed):
  - `fbc941a` T01 scaffold, env validation, deps, folder layout
  - `fe6a11d` T02 migration `0001_init.sql` (matches ARCHITECTURE section 3 line for line) + `lib/db` queries, 17 tests
  - `b67fb3b` T03 Meta client (`createMetaClient`, pricing, strict-schema), 34 tests
  - `f7dffb5` T04 webhook route + guards + bot shell + poll/set-webhook scripts, 29 tests
  - `5f9c3b9` T05 file download, image/PDF normalisation, storage helpers, 33 tests
- Live spend so far: about $0.0005 (smoke call only).
- Decisions:
  - Scaffolded with `create-next-app@15` (not `@latest`, which is Next 16) to match AGENTS.md; keeps `middleware.ts` for T11. Next 15.5.28, React 19.1.
  - shadcn init emitted `lib/utils.ts` importing `cn` from an unrelated `cn` npm package. Replaced with `clsx` + `tailwind-merge`, stray dep removed. shadcn style is `base-nova` (base-ui primitives).
  - `server-only` is mocked via `bunfig.toml` preload (both top-level and `[test]`, bun 1.4.3 reads them separately) so tests and scripts can import env/db modules. `lib/env.ts` parses lazily so `next build` works without keys.
  - Manager wrote stub `lib/db/{client,types,queries}.ts` before P1 so T04/T05 compiled in parallel; T02 replaced them.
  - Manager fix after T03: a model reply that fails JSON/zod validation was logged with no tokens or cost, which under-counted spend for the budget guard. Now logged with tokens and cost (test added).
  - Subagents did not run `bun run build` in parallel (shared `.next`); manager ran it.
- Interfaces later cards need:
  - `createMetaClient({ openai, model, dailyBudgetUsd, logAiCall, getTodaySpend })` in `lib/meta/client.ts`, plus `createOpenAIClient(apiKey, baseURL)`. The app-level wiring that builds the default instance from `env` and `lib/db/queries` does not exist yet; T06a/T06c should create it (e.g. `lib/meta/index.ts`) rather than importing db into `client.ts`.
  - `lib/db/queries.ts`: `createQueries(client)` plus top-level wrappers; `upsertWeakSpot` is select-then-write (no RPC), fine at this scale.
  - `lib/media/storage.ts`: `uploadBuffer`, `downloadBuffer`, `signedUrl`, `annotatedPath` are ready for T10.
  - `lib/telegram/bot.ts`: `registerHandlers(bot)` holds `/start`, `/help` and the placeholder "Got it" handler; T06c replaces the placeholder.
- Follow-ups:
  - `/start` intro links `APP_BASE_URL` as "your dashboard"; fix when T11/T12 land (T06c reply copy).
  - Webhook refusal text lives in `app/api/telegram/route.ts`; move to `replies.ts` in T06c if desired.
- Not done yet: migration has NOT been applied to Supabase (needs the user's go-ahead). No live bot run yet.

### Next
1. User go-ahead to apply `supabase/migrations/0001_init.sql` to the dev Supabase project (and confirm that project is not production).
2. Group P2: T06a (understand prompt + dates), T06b (reconcile + priority), T07 (eval harness). Then T06c wiring, then the Day 1 exit check.

## 2026-10-30 - Planning done, no code yet
- Docs written: AGENTS.md, docs/PRD.md, docs/ARCHITECTURE.md, docs/TASKS.md, docs/ORCHESTRATION.md, Meta API doc snapshots in docs/meta-api/.
- `.env` created with all variable names; `TELEGRAM_WEBHOOK_SECRET` and `SESSION_SECRET` pre-generated. Repo not yet a git repo (T01 runs `git init`).
- Decisions: TypeScript-only Next.js on Vercel; Meta Model API `muse-spark-1.3` (Standard mode) for all reasoning, `muse-voice-transcribe-1.0` for voice; perception grounding for the annotated math photo; no cron (review tasks created with future due dates).
- Open questions for the user: hackathon submission deadline and demo video length limit.

### Next
1. User finishes T00-H (keys in `.env`, Supabase project + bucket, fixtures).
2. Manager runs the Meta smoke call, then T01, then group P1 (T02, T03, T04, T05).
