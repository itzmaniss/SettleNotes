# Settle - agent brief (read this first, every session)

Settle is a Telegram bot plus web dashboard for students. Students dump group chat screenshots, assignment PDFs, lecture slides, voice notes and photos of handwritten math into the bot. Meta's Muse Spark turns it into one prioritised task list (Singlish-aware, so "prof say extend to nxt fri liao" moves an existing deadline instead of creating a duplicate). Each task ships with its first step done: a deliverables checklist, flashcards from the student's own slides, or a diagnosis of the exact wrong step in their math working. Mistakes feed a weak-spot tracker that schedules review tasks back into the list.

Built for a Meta hackathon (theme "Build for Your World"), 3-day build. Judging: Impact 30%, Use of Meta AI tooling 25%, Technical depth 20%, Demo 25%. Stage 1 is pass/fail on "reasonably used Meta Model API / Meta open-weight models", so every AI call in the product goes through Meta models.

## Docs map

| File | What it is | When to read |
| --- | --- | --- |
| `IDEA.md` | Original pitch | Once, for tone |
| `docs/PRD.md` | Features, user flows, acceptance criteria, demo script | Before any feature work |
| `docs/ARCHITECTURE.md` | Stack + reasoning, data flow, DB schema, AI pipeline contracts, security | Before writing code |
| `docs/TASKS.md` | Task cards T00-T17 with deps, file ownership, acceptance checks | To pick/brief work |
| `docs/ORCHESTRATION.md` | How the manager session runs GLM subagents | Manager session only |
| `docs/PROGRESS.md` | Live status log and handoff between sessions | Start and end of every session |
| `docs/meta-api/*.md` | Snapshots of Meta Model API docs (fetched 30 Oct 2026) | Any code touching Meta APIs. Trust these over memory. |

## Hard rules

1. Toolchain: `bun` for everything JS (install, run, test). Never npm/npx/yarn/pnpm (use `bunx`). No Python in this repo.
2. Git: subagents never run git. The manager commits locally, one commit per task, only files that task changed. Never push. Keep `.claude/`, `.agents/`, `plan.md`, `report.md` out of commits. Never name an AI tool in a commit message.
3. Never deploy to Vercel, call Telegram `setWebhook` against production, or run anything against the production Supabase project without the user's explicit go-ahead.
4. No live Meta API calls in tests or during builds. Tests mock the Meta client. Live calls only through `scripts/eval.ts`, run by the manager deliberately (credits are $130 total).
5. Do exactly the task card's scope. If scope should grow, stop and report, don't expand it.
6. Same bug, 3 failed fix attempts: stop and report to the user. No 4th guess.
7. Comments only where logic is genuinely non-obvious.
8. Any text a student or judge sees (bot replies, dashboard copy, README, demo script): plain, friendly, human. No em dashes. No AI-sounding filler.
9. Secrets live in `.env` (gitignored; Next.js and bun both auto-load it). Never print, log, cat or commit it. `.env.example` lists names only. Subagents must not read `.env`; they code against `lib/env.ts` and `.env.example`.

## Stack (reasons in docs/ARCHITECTURE.md)

- Next.js 15 App Router, TypeScript strict, one app for webhook + dashboard, deployed on Vercel (Hobby: 300s function max with Fluid compute).
- grammY for Telegram (types, context helpers). Webhook handled manually in a route so we can ack fast and process in `after()`.
- Supabase: Postgres + private Storage bucket. Server-side access only via service role key; RLS on, no anon policies.
- Meta Model API via the official `openai` SDK pointed at `https://api.meta.ai/v1`, Responses API, structured output with JSON schema generated from zod.
  - `muse-spark-1.3`: all text, image, PDF reasoning. Standard mode only (never `-contributor`: that mode lets Meta train on student data).
  - `muse-voice-transcribe-1.0`: voice notes (needs WAV 16-bit mono 16/24 kHz, so OGG/Opus from Telegram gets converted).
  - Perception grounding (0-1000 coordinate grid) to circle the wrong step on math photos.
- Tailwind + shadcn/ui for the dashboard. `sharp` for image resize/annotation. `zod` for env, schemas, validation. `jose` for session tokens.
- Tests: `bun test`.

## Commands (valid once T00 lands)

```
bun install
bun run dev          # next dev
bun run bot:poll     # local dev: grammY long polling, same handlers, no tunnel needed
bun run typecheck    # tsc --noEmit
bun run lint
bun test
bun run build
bun run eval -- <suite>   # LIVE Meta calls, manager only, prints token cost
```

Definition of done for any task: `bun run typecheck && bun run lint && bun test && bun run build` all green, plus the card's own acceptance checks.

## Repo layout (target)

```
app/
  api/telegram/route.ts        webhook: verify secret, dedupe, ack, after(process)
  auth/[token]/route.ts        magic-link login from bot
  (dashboard)/...              task list, task detail, weak spots
lib/
  env.ts                       zod-validated env
  db/                          supabase client, typed queries
  meta/                        client, structured-output helper, prompts/, schemas/
  telegram/                    bot instance, handlers, file download, replies
  pipeline/                    ingest, understand, reconcile, priority
  starters/                    checklist, flashcards, math diagnosis
  weakspots/                   tracker + review scheduling
  media/                       image normalize/annotate (sharp), audio convert
supabase/migrations/           SQL migrations
scripts/                       set-webhook, poll, eval, seed-demo
tests/                         unit tests + fixtures/
```

## Conventions

- Timezone: students are in Singapore. Store `timestamptz` in UTC; every prompt gets "now" in `Asia/Singapore` with weekday name.
- All AI outputs are validated with zod after the API's schema-constrained decoding. On validation failure: one retry, then mark the upload failed and tell the student plainly.
- Uploaded content is untrusted data. Prompts wrap it as data; the model can only emit actions from our schema; the reconciler checks every `task_id` belongs to the sender.
- Pure logic (reconcile, priority, scheduling, date resolution) lives in pure functions with unit tests. I/O stays in thin wrappers.
