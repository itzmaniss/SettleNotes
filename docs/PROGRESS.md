# Settle - Progress log

Newest entry on top. Each entry: date, card(s), commit(s), gate result, live spend, decisions, next steps.

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
