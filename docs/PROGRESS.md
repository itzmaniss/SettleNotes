# Settle - Progress log

Newest entry on top. Each entry: date, card(s), commit(s), gate result, live spend, decisions, next steps.

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
