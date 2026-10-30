# Manager brief: Direction C UI + pricing-ready billing seams

Paste this into the manager session. It adds four cards to `docs/TASKS.md`. One of them replaces the visual spec in the existing T12. Read `docs/ORCHESTRATION.md` and run its session start checklist first. All existing rules still apply: bun only, subagents write the feature code, one commit per card, never push, and get a go-ahead before anything touches Supabase or Telegram for real.

## 0. What changed and why

- The user picked **Direction C ("Study Loud")** for the landing page and the dashboard. The visual source of truth is `docs/design/C-study-loud.html`. Open it in a browser and use the Landing / Dashboard toggle at the bottom. Full-page screenshots: `docs/design/shots/C-study-loud.png` and `C-study-loud-dash.png`. Directions A and B in the same folder are rejected. Do not mix them in.
- **Pricing** (Free + Pro) is decided for after the hackathon, but the code has to be ready for it now. For the hackathon we build the **seams only**: plan config, a usage ledger, an entitlement check and the pricing section. All of it sits behind `BILLING_ENABLED=false`, so the bot behaves exactly as it does today. Payments (Telegram Stars + Stripe) come later as separate cards, and none of today's code should need rewriting when they land.
- The PRD's non-goals still hold for the hackathon: no live payments, and the allowlist stays on.

## 1. Design system (Direction C)

Map these to the existing shadcn variable names in `app/globals.css`. Replace the neutral palette, and keep the `@theme inline` block and the base-nova setup.

| Token | Value | Use |
| --- | --- | --- |
| `--background` | `oklch(0.975 0.012 120)` | mint-white page |
| `--foreground` / `--border` / `--primary` | `oklch(0.2 0.02 270)` | ink: text, 2px borders, hard shadows, dark buttons |
| `--card` | `oklch(1 0 0)` | cards |
| `--muted` | `oklch(0.94 0.02 120)` | quiet fills |
| `--muted-foreground` | `oklch(0.5 0.02 270)` | secondary text |
| `--accent` | `oklch(0.9 0.19 125)` | lime: primary CTA, "Next up" card, done checkbox |
| `--accent-foreground` | `oklch(0.25 0.06 130)` | text on lime |
| `--pop` (new) | `oklch(0.72 0.17 300)` | lilac stickers, flashcard back (use at 25-30% or `oklch(0.9 0.06 300)`) |
| `--destructive` | `oklch(0.63 0.21 25)` | overdue, wrong-step ring |
| `--radius` | `1.25rem` | |

Fonts via `next/font/google`: **Unbounded** 500/700/800 (`--font-display`, headings, prices, stickers), **Geist** (body, already installed), **Geist Mono** (dates, page refs, eyebrow labels), **Caveat** 600 (only for handwriting: the math photo placeholder and one-line asides). Light theme only for now. Drop T12's "dark mode via prefers-color-scheme" line.

Primitives. Build these as real components in `components/settle/` on top of shadcn. Do not paste the mock's raw CSS.
- `Chunk`: card with `border-2 border-border rounded-[var(--radius)] shadow-[4px_4px_0_0_var(--foreground)]`. Background is a prop (`card | accent | pop | ink`). In the mock, the `bg-card` default overrode the variants and made one CTA white-on-white. Make the variant win, through cva rather than `!important`.
- `ChunkButton`: pill, 2px border, `3px 3px 0` shadow, press state translates the button by 3px and removes the shadow. Add it as a shadcn `Button` variant (`variant="chunk"`) instead of a separate component.
- `Sticker`: small Unbounded pill, 2px border, optional slight rotation. Used for course codes, statuses ("overdue", "moved", "diagnosis") and marketing tags.
- `Check`: 24px rounded-square checkbox, lime fill and ink tick when checked. Wrap shadcn `Checkbox` so it stays accessible.
- `FlipCard`: 3D flip on click/Enter/Space with a springy `cubic-bezier(.3,1.4,.5,1)`. Under `prefers-reduced-motion` it swaps faces with no animation.
- Math: `katex` (manager runs `bun add katex` before releasing the cards). Server-render it with `katex.renderToString` in a small `Tex` component.

Copy rules: plain, human, no em dashes, Singlish only inside the example chat bubbles. Keep the mock's real examples (CS2040 Lab 4 moved by "prof say extend to nxt fri liao", MA1521 Quiz 2, GEA1000 brief, product rule step 2). Don't invent stats or testimonials.

**Mobile first.** Students open the dashboard from Telegram on a phone, and the mock is desktop-only. At under 768px, the dashboard is one column in this order: Next up, This week, Quick study, Weak spots. Tap targets are at least 44px. The hero cards on the landing page stop overlapping: the chat card goes on top, the task card below with a small offset.

## 2. Cards to add to docs/TASKS.md

### T12 (revised). Dashboard UI in Direction C
- Deps and Owns: unchanged (`app/(dashboard)/`, `components/`, `app/globals.css`, `app/layout.tsx`). It now also owns `components/settle/`.
- Spec: PRD F5 data and behaviour exactly as the original T12, rendered in Direction C. The layout is the mock's `#dash` view:
  - "Next up" = the single highest-priority open task (`lib/pipeline/priority.ts`) as a lime `Chunk`, with start and later actions.
  - "This week" list: each task is a `Chunk` row with `Check`, title, a due line, and a sticker for its kind or status. A task moved by the reconciler shows a "moved" sticker and its evidence quote from `task_events`.
  - Task detail renders its starter by type: checklist (server action), flashcards (`FlipCard` plus Again/Hard/Got it, local state only for now), math diagnosis (annotated image via signed URL, numbered `Tex` steps, wrong step ringed in destructive, misconception, practice with reveal).
  - Weak spots panel: one row per topic, occurrences shown as segment pips, "recurring" at 3 or more.
  - Header nav: Tasks / Study / Weak spots. Remove the "Study" link if the route doesn't exist by Day 3.
- Plan-aware but inert: read `getPlanForUser()` from `lib/billing` (T19). When billing is disabled it returns `pro`, so nothing is locked. Do not render upgrade prompts in this card.
- Done when: build green, plus manager screenshots at 390px and 1440px with seeded data, compared side by side with `docs/design/shots/C-study-loud-dash.png`.

### T18. Landing page (P3, parallel with T12 once T19's `plans.ts` exists)
- Deps: T01, T19 `plans.ts`. Owns: `app/page.tsx`, `app/(marketing)/` (if used), `components/marketing/`. Import primitives from `components/settle/`. If T12 hasn't landed them yet, the manager lands the primitives first as a tiny pre-card.
- Spec: the mock's landing view, sections in order:
  1. Pill nav
  2. Hero with the stacked chat-to-week cards
  3. "Every task comes pre-started" bento: math photo large, flashcards, checklist
  4. Pricing
  5. Dark loop CTA
  6. Footer

  CTAs link to `https://t.me/${TELEGRAM_BOT_USERNAME}`.
- Pricing section is rendered **only from `lib/billing/plans.ts`**: names, prices, feature bullets, monthly/yearly toggle. No hardcoded numbers in JSX. While `BILLING_ENABLED=false` the Pro button reads "Coming soon" (disabled) and the payment line is hidden. A config flip later turns it into "Get Pro" with no JSX edit.
- Metadata: real `title` and `description` (the layout still says "Create Next App").
- Done when: build green, Lighthouse a11y at least 90, and 390px/1440px screenshots match the mock.

### T19. Billing seams (hackathon, flag off)
- Deps: T02, T06c. Owns: `lib/billing/`, `supabase/migrations/0002_billing.sql`, `tests/billing/`. It may add one `BILLING_ENABLED` boolean (default false) to `lib/env.ts` and `.env.example`; the manager applies that edit.
- `lib/billing/plans.ts`: the single source of truth, used by the landing page, the bot and the gate:
  ```ts
  export type PlanId = "free" | "pro";
  export type Feature = "chat_capture" | "math_diagnosis" | "slides_flashcards" | "brief_checklist" | "weak_spot_tracker";
  export const PLANS: Record<PlanId, {
    name: string;
    price: { monthly: number; yearly: number; currency: "SGD" | "USD"; stars: { monthly: number } | null; anchor: string | null };
    quotas: Record<Feature, number | "unlimited" | "off">;   // per calendar month, Asia/Singapore
    fairUse: Partial<Record<Feature, number>>;               // hard caps even on "unlimited"
    bullets: string[];                                       // marketing copy for the pricing card
  }>;
  ```
  Values (decided by the user, see section 4):
  - **free**: `chat_capture` unlimited, `math_diagnosis` 3, `slides_flashcards` 1, `brief_checklist` 1, `weak_spot_tracker` unlimited (free for everyone).
  - **pro**: all unlimited. Fair-use caps: `math_diagnosis` 300, `slides_flashcards` 60, `brief_checklist` 60. Price **S$7.99 / S$63.99** (yearly is 33% off, about S$5.33 a month), `currency: "SGD"`, `stars: null` (set later).
  - Prices display as `S$7.99` everywhere (landing, dashboard). Never a bare `$`.
- Migration `0002_billing.sql`. Write it, but do **not** apply it without the user's go-ahead:
  - `subscriptions(id uuid pk, user_id fk, provider text check in ('stars','stripe','manual'), provider_ref text, plan text, status text check in ('active','canceled','past_due'), current_period_end timestamptz, created_at, updated_at, unique(provider, provider_ref))`.
  - `usage_events(id uuid pk, user_id fk, feature text, upload_id uuid fk null, status text check in ('claimed','consumed','released'), created_at, unique(upload_id, feature))`. The unique key makes Telegram retries idempotent.
  - `billing_events(id text pk, provider text, payload jsonb, received_at)` for webhook dedupe later.
  - SQL function `claim_usage(p_user uuid, p_feature text, p_upload uuid, p_limit int, p_period_start timestamptz) returns boolean`. It takes `pg_advisory_xact_lock` on the user, counts the period's claimed and consumed rows, and inserts a `claimed` row only if the count is under the limit. Two photos sent in the same second must not both get through when only one use is left.
  - RLS on with no policies, same as 0001.
- `lib/billing/entitlements.ts`:
  - `getPlanForUser(userId)` returns `pro` if billing is disabled; otherwise `pro` if there is an active subscription with `current_period_end > now()`, else `free`. Computed on read, so no cron and no monthly reset job.
  - `claimFeature(user, feature, uploadId)` returns `{ ok: true, usageId } | { ok: false, reason: "quota" | "fair_use", used, limit }`.
  - `consumeUsage(usageId)` and `releaseUsage(usageId)`.
  - A pure `periodStart(now)` for the start of the month in Asia/Singapore.
- Gate placement: in `lib/pipeline/ingest.ts` and the starter dispatcher (T08's `generateStarterFor`, T10's `onMathWorking`). The order is: understand (always runs, deadline extraction is free), then `claimFeature`, then the starter AI call, then `consumeUsage` on success or `releaseUsage` on failure. **A failed or garbled AI call must never use up a student's quota.** Only starters, diagnoses and the weak-spot review creation are gated. Reconcile and task writes are never gated.
- Quota-hit reply: in `lib/telegram/replies.ts` (manager serialises the edit). The bot states the limit and points to the dashboard. It does **not** sell inside Telegram: no price, no "buy" or "upgrade" button, no checkout or pricing URL. Copy:
  > "You've used your 3 free math checks for October. They reset on 1 Nov. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan."
  - The month name, reset date and limit come from `plans.ts` and `periodStart()`, not hardcoded.
  - `/dashboard` is the existing magic-link login, so this is the normal dashboard link, not a purchase link.
  - The web dashboard is where the upgrade panel lives: a "Plan" card with usage this month (3/3 math checks, 1/1 decks, 0/1 briefs), and an "Upgrade to Pro" button that goes to Stripe once T21 exists. Before T21 the button reads "Coming soon". This card belongs to T12, read-only from `lib/billing`.
  - Keep the copy in one exported constant so the user can change the wording in one place. See section 3, point 1, for why the bot avoids the word "upgrade".
- Usage is recorded even with billing disabled, so we have real per-feature numbers when we set limits.
- Done when there are tests for:
  - quota allowed, quota hit and the fair-use cap
  - concurrent claim (two claims with one use left: exactly one wins; mock the RPC, plus one SQL-level test if a DB is available)
  - release on AI failure
  - retry idempotency (same `upload_id`)
  - `BILLING_ENABLED=false` means everyone is pro and nothing is blocked
  - landing pricing renders from config

### Post-hackathon (write these cards now, do not start them)

**T20. Telegram Stars subscription (bot).** Required before public launch, not optional: Telegram requires anything sold on the website to also be buyable with Stars in the bot. Stars price is decided by the user at that point. `createInvoiceLink` with `currency: "XTR"`, empty `provider_token`, `subscription_period: 2592000` (the only allowed value, 30 days). The `billing:upgrade` callback sends this invoice. Handle `pre_checkout_query` (answer within 10s) and `successful_payment`. Upsert `subscriptions` with `provider='stars'`, `provider_ref=telegram_payment_charge_id`, and `current_period_end` from `subscription_expiration_date`. Add a required `/paysupport` command and `refundStarPayment` for refunds. Add `pre_checkout_query` to `allowed_updates` in `scripts/set-webhook.ts` (currently `["message","callback_query"]`), then re-run it with the user's go-ahead.

**T21. Stripe on the web.** Dashboard-only (`/billing`). A Checkout Session is created **per logged-in user** (`client_reference_id = user.id`, metadata `user_id`). A static payment link can't tell us who paid, so it won't work. Add the Customer Portal for cancel/update. Webhook route: verify the signature on the raw body before parsing, dedupe via `billing_events`, and handle `checkout.session.completed`, `customer.subscription.updated|deleted` and `invoice.payment_failed`. Upsert `subscriptions` with `provider='stripe'`. The route stays a thin wrapper and the logic lives in `lib/billing/stripe.ts` (Next route files may only export handlers). If the user wants PayNow, keep it to the yearly plan as a one-time charge, because PayNow doesn't support recurring payments.

**T22. Launch switch.** `BILLING_ENABLED=true`, remove the allowlist, add terms, privacy (PDPA) and refund pages, an upgrade prompt on dashboard lock states, and a launch smoke test. Needs the user's go-ahead and a Telegram heads-up.

## 3. Corrections to the pricing research (do not build these parts as written)

1. **No Stripe link inside the bot.** Telegram's rules for bots: digital goods and services sold inside Telegram must be paid in **Telegram Stars**, even if you also sell on your own website, and a bot that breaks this can be hidden from mobile users. If Pro is sold on the website, it must also be buyable with Stars in the bot. So: Stars in the bot (T20), Stripe on the web dashboard (T21), both writing to the same `subscriptions` table. The research's "bot replies with a Stripe Checkout link" is exactly what's forbidden. The same goes for telling users in the bot to go and upgrade on the website: Apple and Google treat that as steering to an outside purchase, and those are the rules Telegram enforces. The bot only states limits and offers the normal `/dashboard` link. Selling happens on the website. Before scaling, T20 adds Stars.
2. **Telegram ID is already the identity.** `users.telegram_user_id` is `unique not null` and the PK stays a uuid. That gives the anti-sharing property without changing the primary key everywhere.
3. **No `monthly_ai_credits` counter column.** A single counter can't express "3 diagnoses + 1 deck", it double-spends under concurrent messages, and it needs a monthly reset cron (Vercel Hobby cron is daily only). The ledger plus `claim_usage` above replaces it.
4. **Cost per student is closer to US$1.50-2.00/month for a heavy user, not US$0.24.** The research leaves out reasoning tokens, the open-task context sent with every call, and the separate starter call per PDF. ARCHITECTURE section 7's own figures: math diagnosis about $0.04 each, so 30 of them is about $1.20; 50 forwards at about $0.005-0.01 is about $0.40; 4 slide PDFs (understand plus flashcards) at about $0.11 is about $0.45. Still viable, but:
   - At S$7.99, Pro margin is about 55% for a heavy user and about 75% for a typical one, not 90%+. Stripe Singapore is 3.4% + S$0.50 per charge plus about 0.7% for Billing, so roughly 10% (about S$0.83) of a S$7.99 charge. Stars cost more: buying Stars through Apple/Google plus Telegram's payout rate leaves roughly two thirds of the sticker price. Verify current rates before setting the Stars price.
   - That's why Pro has fair-use caps and why yearly billing is pushed on the web: one fixed fee a year instead of twelve.
   - Get the real numbers from `ai_calls` and `usage_events` after the Day 2 evals, and adjust `plans.ts`.
5. Muse Spark 1.3 pricing is confirmed: $1.25 in / $0.15 cached / $4.25 out per 1M tokens, no long-context premium (dev.meta.ai pricing page). The research's comparison with "Claude 3.5 Sonnet / GPT-4o" uses old models. Keep it out of any public copy.

## 4. Product decisions (decided by the user)

1. Currency: **SGD**. Pro is **S$7.99 a month** or **S$63.99 a year**.
   - Price anchor: "Less than a McSpicy meal." The McSpicy Extra Value Meal is S$8.30 in-store and about S$9.95 on delivery apps (Sept 2026). Put it in `plans.ts` as `anchor` copy next to the price, not hardcoded in JSX. It shows on the Pro card under the price and on the Pro sticker.
   - McDonald's runs S$6.50 McSpicy meal promos a few times a year, and during those weeks the line isn't true. Keep the anchor in one config field so it can be swapped or turned off (`anchor: null`), and re-check the menu price before launch.
   - Name McDonald's only as a price comparison, with no logo or imagery.
2. Weak-spot tracker: **free for everyone**. The research had it in Pro only. Pro sells unlimited diagnoses, briefs and slides.
3. Assignment-brief checklists on Free: **1 per month**.
4. Stars price: **not set yet**. `stars: null` until T20, and the user decides it then.
5. Out-of-limit flow: the bot states the limit and points to `/dashboard`, and upgrading happens on the website (section 3, point 1, has the wording rule).

Update the landing pricing bullets to match: Free lists "Weak-spot tracker with spaced reviews" and "1 assignment brief to checklist a month"; Pro lists "Everything in Free", "Unlimited math checks" and "Unlimited briefs, slides and PDFs". The mock in `C-study-loud.html` already matches.

## 5. Order of work

1. Manager: `bun add katex`, add the `BILLING_ENABLED` env flag, land `lib/billing/plans.ts` (types plus defaults) and the `components/settle/` primitive stubs, so the parallel cards compile.
2. Parallel group: T19 (billing seams) alongside the existing T08-T11. Then T12 (revised) and T18 in parallel. Owns lists are disjoint, and `lib/telegram/replies.ts` and `handlers.ts` edits are serialised by the manager.
3. Ask the user before applying `0002_billing.sql` to Supabase.
4. Write T20-T22 into TASKS.md, mark them post-hackathon, and do not start them.
5. Append each card to `docs/PROGRESS.md` as usual.
