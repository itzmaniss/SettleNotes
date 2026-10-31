# Settle

Settle turns the deadline chaos in students' Telegram chats into one calm task list, then does the first step of every task for you.

Built for the Meta hackathon theme "Build for Your World", for Singapore students who live in Telegram.

## The problem

Students don't fail because they can't do the work; they lose track of it. Deadlines sit in group chats, briefs run 30 pages, slides pile up, and mistakes in practice papers go unnoticed until the exam. Remembering what to do eats the energy that learning needs.

## What Settle does

One Telegram bot, one web dashboard, one task list.

- **Capture anything.** Forward a group chat screenshot, drop an assignment brief or lecture slides PDF, photograph handwritten math working, or send a voice note. One AI call reads the input together with your current tasks, so "prof say extend to nxt fri liao" moves the existing deadline instead of creating a duplicate.
- **First step done.** A brief becomes a tickable checklist of deliverables and submission rules. Slides become flashcards and practice questions from your own course material.
- **Math, pinned down.** A photo of your working comes back with the first wrong step circled, the misconception named, and a few targeted practice questions.
- **Weak spots come back on purpose.** Every diagnosed mistake feeds a tracker that schedules short spaced reviews as normal tasks, due before the exam, not the night before.

## The flow

1. You send the bot anything: text, screenshot, PDF, photo, voice note.
2. It reads the input, decides create / update / complete / ignore against your open tasks, and replies with a plain summary plus an "Open dashboard" button.
3. Documents and photos get their starter: checklist, flashcards, or an annotated math photo.
4. Wrong math upserts a weak spot and schedules a review task (3 days out the first time, 1 day after that).
5. The dashboard groups everything into Overdue, Today, This week and Later, and task history keeps the verbatim chat quote behind every deadline change.

## How we use Meta AI

All reasoning goes through Meta models. No other AI provider is called anywhere in the repo.

| Where | What runs |
| --- | --- |
| Understanding every input | `muse-spark-1.3` (Standard mode) through the OpenAI-compatible Responses API at `api.meta.ai`. Text, screenshots and PDFs are native inputs of the same call, which also sees the student's current open tasks so it can update instead of duplicate. |
| Voice notes | `muse-voice-transcribe-1.0`, with `languageBias: ["English"]` and the student's own course codes (CS2040, MA2001, ...) as recognition keywords. The transcript then flows through the same understanding call. |
| Structured output | Every answer is schema-constrained: zod v4 schemas compile to JSON Schema and are sent with `text.format: { type: "json_schema", strict: true }`, so the model's reply either matches the shape or gets exactly one retry. |
| Reasoning effort per task | `low` for plain texts, `medium` when a document or screenshot is attached and for checklist and flashcard generation, `high` for math diagnosis with a 200 second budget. Cheaper reads stay cheap; math gets the effort it needs. |
| Perception grounding | The math diagnosis returns bounding boxes on Meta's 0 to 1000 image grid. Settle maps them onto the exact photo and sends back a JPEG with the first wrong step circled in red. |
| Prompt caching | System prompts are constants per purpose (no dates, no user data), so Meta caches them; in the live understanding eval about 90% of input tokens came back cached. |
| Privacy | Standard mode on purpose: content sent through it is not used to train Meta's models. Student work stays student work. |
| Cost guard | Every call is logged with tokens and computed cost (`ai_calls` table, $1.25 / $0.15 cached / $4.25 per 1M tokens, transcribe $0.18/hour) and a hard daily USD budget refuses new calls before they are spent. |

## Architecture

```
 Telegram app
     |
     v
 POST /api/telegram --- secret header check, allowlist, update dedupe, ack 200
     |
     v
 lib/pipeline/ingest -- download + normalise (image / PDF / text / voice)
     |                   store original in Supabase Storage
     v
 Meta Model API (muse-spark-1.3, Responses API)
     |    understand: one call sees the input plus the open tasks
     |    voice: muse-voice-transcribe-1.0 first, then understand
     |    math photo: diagnosis at high reasoning effort
     v
 lib/pipeline/reconcile (pure planner) -> create / update / complete
     |    task_events rows keep the verbatim evidence quote
     |
     +--> starters: checklist (briefs), flashcards (slides),
     |              math diagnosis + annotated photo (sharp)
     +--> weak spots: upsert + spaced review task
     |
     v
 Reply in Telegram (summary + Open dashboard button)
     |
     v
 Supabase (tasks, events, starters, weak spots, ai_calls)
     |
     v
 Next.js dashboard (magic link login) reads the same rows
```

| Piece | Choice | Why |
| --- | --- | --- |
| App | Next.js 15 App Router, TypeScript | Webhook route and dashboard in one deploy, one shared type system end to end. |
| Bot | grammY | Typed Telegram framework; the route acks first, then processes. |
| Data | Supabase (Postgres + Storage) | Relational tasks, events and starters; a private bucket for photos; a table view you can watch live. |
| AI client | `openai` SDK against the Meta endpoint | Responses API is Meta's recommended surface; reasoning effort and strict JSON schema are first-class there. |
| Images | sharp | Normalises photos and draws the red ring on the annotated math photo without a font dependency. |
| Audio | ffmpeg-static | Telegram voice is OGG/Opus; transcription wants WAV, and the binary fits serverless limits. |
| Auth | Bot-issued magic links + `jose` | Students already proved identity to Telegram; no passwords, no email. |
| UI | Tailwind + shadcn/ui | Calm, minimal dashboard, fast to build. |
| Runtime | bun | One toolchain for scripts, tests and the dev server. |

## Where things live

| Folder | What is there |
| --- | --- |
| `lib/telegram/` | Bot wiring, handlers per input type, all student-facing reply wording. |
| `lib/pipeline/` | Understand prompt, pure reconcile planner, priority scoring, date helpers, ingest wiring. |
| `lib/starters/` | Checklist, flashcards and math diagnosis generation plus the shared zod content schemas. |
| `lib/media/` | Image/audio normalisation, math photo annotation, Storage helpers. |
| `lib/meta/` | Meta API client, strict-schema conversion, pricing, prompts, voice transcription. |
| `lib/weakspots/` | Weak-spot upsert, spaced review scheduling, dashboard view model. |
| `lib/db/` | Typed queries for the webhook and dashboard reads. |
| `lib/auth/` | Magic-link tokens, session cookies, `/dashboard` command. |
| `lib/billing/` | Usage ledger and quota seams behind a flag (not live). |
| `app/` | Webhook route, auth routes, dashboard pages. |
| `scripts/` | Polling bot, webhook setup, eval harness, demo seeder. |

## Safety and privacy

- **Allowlist.** Only Telegram ids in `ALLOWED_TELEGRAM_IDS` get replies; the demo seeder refuses to touch anyone else.
- **Secret-checked webhook.** The secret header is compared in constant time before the body is parsed; mismatches get a generic 401.
- **Dedupe.** Every Telegram update id is recorded once, so retries never double-spend AI credits or double-create tasks.
- **Magic-link login.** 32 random bytes, only the sha256 hash stored, single use, 15 minute expiry; the session is a signed httpOnly cookie for 7 days.
- **Database lockdown.** Row level security is enabled on every table with zero policies, so only the server's service key can read or write; uploaded files sit in a private bucket served through short-lived signed URLs.
- **Content is data, not instructions.** Uploaded text is wrapped in delimiters inside the prompt, output is schema-constrained, and the model has no tools; all writes go through the pure reconciler.
- **Limits.** 20 MB download cap, PDFs read past 50 pages are truncated and the student is told, voice notes over 3 minutes are politely refused.

## Testing and evaluation

- `bun test` runs 893 tests across the pipeline, starters, auth, dashboard, billing and bot layers. None of them touch the network or the real database.
- `bun run eval -- understand` is a 13 fixture Singlish eval suite (extend liao, tmr deadlines, duplicates, chit chat, an injection attempt and more). The live run finished 13 of 13.
- The math eval on real photos of handwritten working has not been run yet; it is the next measurement, as are live checklist and flashcards runs on real PDFs.

## Run it yourself

Prerequisites: [bun](https://bun.sh), a Telegram bot token from @BotFather, a Meta Model API key from dev.meta.ai, and a Supabase project.

1. Clone and install:

   ```
   git clone https://github.com/itzmaniss/SettleNotes.git
   cd SettleNotes
   bun install
   ```

2. Copy `.env.example` to `.env` and fill in the values. The names to fill: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_TELEGRAM_IDS`, `MODEL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`, `SESSION_SECRET`, `APP_BASE_URL`.

3. In Supabase, apply `supabase/migrations/0001_init.sql` (SQL editor or CLI, in one transaction) and create a private storage bucket named `uploads`. `0002_billing.sql` is optional and off by default; skip it unless you want the usage ledger.

4. Talk to the bot locally with long polling, no tunnel needed:

   ```
   bun run bot:poll
   ```

5. Dashboard in a second terminal:

   ```
   bun run dev
   ```

   Locally the bot replies have no "Open dashboard" button (Telegram rejects localhost URLs); use the `/dashboard` command's magic link instead. Deploy behind https and the button appears.

6. For a deployed https URL only, point Telegram's webhook at it:

   ```
   bun run scripts/set-webhook.ts
   ```

### Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Dashboard dev server. |
| `bun run bot:poll` | Long-polling bot for local development. |
| `bun run typecheck` | TypeScript, strict. |
| `bun run lint` | ESLint. |
| `bun test` | Full test suite, no network. |
| `bun run build` | Production build. |
| `bun run eval -- understand` | Eval dry run, no keys needed. Add `--live` to spend. |
| `bun run seed:demo` | Dry-runs a demo seed; add `-- --telegram-id <id> --reset --yes` to write a lived-in demo dashboard for an allowlisted user. |

## Status

Built and working: capture from text, screenshots and PDFs with Singlish-aware updates, the three starters, the weak-spot loop, magic-link dashboard, voice notes, eval harness, demo seeder.

Honest edges:

- Billing and payments are built as seams behind a flag and are not live. `BILLING_ENABLED=false` treats everyone as unlimited; no money changes hands anywhere.
- The math accuracy number on real photos is still pending; the eval scaffolding exists but the fixtures have not run.
- Clarifying questions with inline buttons for ambiguous inputs are planned hardening, not shipped.
- Deployment is not done yet; local runs use long polling.

See docs/DEMO.md for the demo recording shot list, docs/PRD.md for the product spec and docs/ARCHITECTURE.md for the full design.
