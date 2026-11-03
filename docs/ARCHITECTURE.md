# Settle - Architecture

## 1. Stack decisions and why

| Decision | Choice | Why | Rejected |
| --- | --- | --- | --- |
| Language | TypeScript everywhere | One language for webhook, pipeline and dashboard; shared types (`Task`, `Starter`, `WeakSpot`) across the stack; agents work best in one coherent repo. | Python FastAPI backend: second runtime and deploy target for no gain. Its one real advantage (PDF/image wrangling) disappears because Meta Model API ingests PDFs natively (text + page images, up to 50 pages) and images as base64. |
| App framework | Next.js 15 App Router | Webhook route + dashboard in one deploy. Server components read Supabase directly, no separate API layer. `after()` lets us ack Telegram and keep working. | Separate bot server: another thing to host. |
| Hosting | Plain VPS with Docker + Caddy (current) | One app container (Next.js standalone, non-root, health checked) plus Caddy for automatic HTTPS; runbook in `docs/DEPLOY.md`, compose and Caddyfile in `deploy/`. No per-request time limits to design around, and the box is ours. | Self-hosting was rejected during the 3 day build as unnecessary ops; that decision changed when the project outgrew the demo: Vercel Hobby is non-commercial, so production moved to the VPS. The Vercel deployment stays up as a hackathon demo only. |
| Telegram lib | grammY | Best-typed TS Telegram framework, `Context` helpers, `InputFile`, keyboards. We use `bot.handleUpdate()` inside our own route rather than `webhookCallback`, because `webhookCallback` awaits the handler and we want to ack first. | telegraf: weaker types, slower maintenance. |
| DB / storage | Supabase (hosted) | Relational data (users -> tasks -> starters, weak spots), a table viewer to watch data live during the demo, Storage for original and annotated images. Hosted, not local: the local Supabase CLI stack needs Docker, which this machine doesn't run. | SQLite/Turso: no storage bucket, no dashboard. |
| AI | Meta Model API, `muse-spark-1.3` | Natively multimodal (text, image, PDF, audio, video), 1M context, schema-constrained structured output, per-call reasoning effort, perception grounding (coordinates). One model replaces the old "Llama text + Llama vision + GPT fallback" split, cheaper ($1.25 / $4.25 per 1M in/out) and fully counts as Meta tooling. | Muse Spark Open: open weights, needs self-hosting or a third-party host; the hosted API is what the credits pay for. Mentioning it in the pitch is fine. |
| Speech | `muse-voice-transcribe-1.0` | Dedicated ASR, $0.18/hour, `languageBias` + `keywords` (course codes). Docs say Spark 1.3 audio input is degraded. Second distinct Meta model = stronger "Use of Meta AI" score. | Spark 1.3 audio: flagged degraded in docs. |
| AI client | `openai` SDK, Responses API | Meta's docs and examples target it; Responses is their recommended surface (full features, file inputs, `reasoning.effort`). zod schemas converted with `z.toJSONSchema()` (zod v4) into `text.format: { type: "json_schema" }`. | Vercel AI SDK: extra abstraction over the same calls; fine but one more thing for agents to get wrong. |
| UI | Tailwind + shadcn/ui | Fast, clean, agents know it well. | |
| Images | `sharp` | Resize before upload (cost, latency), draw SVG overlay boxes for the annotated math photo. Ships in the app image. | |
| Audio convert | `ffmpeg-static` | Telegram voice is OGG/Opus; transcription wants WAV 16-bit mono 16 kHz. Static binary ships in the app image. | |
| Auth | Bot-issued magic link + `jose` signed cookie | Students already proved identity to Telegram; no passwords, no email. | Supabase Auth: needs email/OAuth, slower demo. Telegram Login Widget: needs domain setup with BotFather. |
| Weak-spot scheduling | Create the review task immediately with a future `due_at` | No cron needed at all: the task simply surfaces when due. | Cron job / DB trigger. |

## 2. Request flow

```
Telegram ──POST──> /api/telegram (route.ts, runtime nodejs, maxDuration 300)
  1. constant-time compare X-Telegram-Bot-Api-Secret-Token vs TELEGRAM_WEBHOOK_SECRET  -> 401 on mismatch
  2. parse JSON update; insert update_id into telegram_updates (PK) -> if conflict, return 200 (Telegram retry, already handled)
  3. allowlist check on from.id (ALLOWED_TELEGRAM_IDS) -> polite refusal reply
  4. after(() => bot.handleUpdate(update))
  5. return 200 immediately

bot.handleUpdate -> middleware: allowlist -> consent gate (nothing stored or sent anywhere before Terms acceptance) -> handler by message type
  -> sendChatAction("typing") (repeat every 4s while working)
  -> rate limit from the uploads table (8 per rolling 60s, 150 per rolling day, fails open)
  -> lib/telegram/files: getFile -> download buffer (<= 20 MB); voice notes over 180s refused before download
  -> lib/media: normalize (images -> JPEG max 2000px long edge; PDFs pass through; voice -> WAV 16k)
  -> store original in Storage, insert uploads row (status=processing)
  -> lib/pipeline/ingest:
       voice  -> transcribe -> text
       photo  -> understand() decides kind; if math_working -> starters/math directly
       other  -> understand(input, openTasks, nowSGT, last few turns) -> actions[] (+ optional plain answer)
  -> lib/pipeline/reconcile(actions, openTasks) -> DB ops (pure planner + thin executor)
  -> low-confidence actions become Yes/No buttons (pending_actions, expire after a day)
  -> for each created task with a source doc: usage ledger claim, then starter (checklist / flashcards)
  -> reply summary + "Open dashboard" button; uploads.status=done
  on any error: uploads.status=failed, error stored, friendly reply, never throw past handleUpdate
```

Local dev: `scripts/poll.ts` runs the same `bot` with long polling (`bot.start()` after `deleteWebhook`), so no tunnel is needed. A cloudflared quick tunnel is the fallback for testing the real webhook route.

## 3. Database schema (supabase/migrations/, five ordered files)

Nine tables come from `0001_init.sql`, then three billing tables from `0002_billing.sql` (dormant behind `BILLING_ENABLED=false`, but the usage ledger writes from day one), the clarification buttons from `0003_pending_actions.sql`, the terms acceptance columns from `0004_terms_acceptance.sql` and the purchase confirmations from `0005_purchase_confirmations.sql`: fourteen tables in all. RLS is enabled with zero policies on every one of them, so only the service role (server) can touch data.

`0001_init.sql`:

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint unique not null,
  telegram_chat_id bigint not null,
  first_name text,
  timezone text not null default 'Asia/Singapore',
  created_at timestamptz not null default now()
);

create table telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

create table uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('text','photo','document','voice')),
  telegram_file_id text,
  mime_type text,
  storage_path text,
  text_content text,              -- message text, caption, or transcript
  classified_as text,             -- chat_screenshot | assignment_brief | lecture_slides | math_working | other
  status text not null default 'processing' check (status in ('processing','done','failed')),
  error text,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  course text,
  kind text not null check (kind in ('assignment','test','reading','math_practice','review','other')),
  due_at timestamptz,
  effort text check (effort in ('small','medium','large')),
  status text not null default 'open' check (status in ('open','done','dismissed')),
  origin text not null default 'capture' check (origin in ('capture','weak_spot')),
  source_upload_id uuid references uploads(id) on delete set null,
  weak_spot_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on tasks (user_id, status, due_at);

create table task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  upload_id uuid references uploads(id) on delete set null,
  action text not null check (action in ('created','updated','completed','reopened')),
  before jsonb,
  after jsonb,
  evidence text,                  -- verbatim quote from the input that justified the change
  created_at timestamptz not null default now()
);

create table starters (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  type text not null check (type in ('checklist','flashcards','math_diagnosis','review_practice')),
  content jsonb not null,         -- shape = zod schema in lib/starters/types.ts
  annotated_image_path text,
  created_at timestamptz not null default now()
);

create table weak_spots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  topic text not null,            -- from MATH_TOPICS taxonomy
  latest_misconception text not null,
  occurrences int not null default 1,
  last_seen_at timestamptz not null default now(),
  next_review_at timestamptz,
  unique (user_id, topic)
);
alter table tasks add foreign key (weak_spot_id) references weak_spots(id) on delete set null;

create table login_tokens (
  token_hash text primary key,    -- sha256 of the raw token; raw token only ever in the link
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table ai_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  purpose text not null,          -- understand | checklist | flashcards | math | transcribe
  model text not null,
  input_tokens int, output_tokens int, cached_tokens int, audio_seconds int,
  cost_usd numeric(10,6),
  latency_ms int,
  ok boolean not null,
  created_at timestamptz not null default now()
);

-- RLS on everything, no policies: only the service role (server) can touch data.
alter table users enable row level security;
alter table telegram_updates enable row level security;
alter table uploads enable row level security;
alter table tasks enable row level security;
alter table task_events enable row level security;
alter table starters enable row level security;
alter table weak_spots enable row level security;
alter table login_tokens enable row level security;
alter table ai_calls enable row level security;
```

`0002_billing.sql` (billing seams; read by `lib/billing/`):
```sql
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('stars','stripe','manual')),
  provider_ref text not null,     -- charge id / session id, unique per provider
  plan text not null check (plan in ('free','pro')),
  status text not null check (status in ('active','canceled','past_due')),
  current_period_end timestamptz, -- plan is computed on read: active + end in the future
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_ref)
);

-- One row per claimed use. The plan gate claims before the AI call runs and
-- the row is marked consumed on success or released on failure, so a garbled
-- AI call never uses up quota. unique(upload_id, feature) makes a Telegram
-- retry of the same upload idempotent; NULL upload_id rows never collide
-- (Postgres unique allows many NULLs), which is intended for claims that have
-- no upload behind them.
create table usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  feature text not null check (feature in ('chat_capture','math_diagnosis','slides_flashcards','brief_checklist','weak_spot_tracker')),
  upload_id uuid references uploads(id) on delete set null,
  status text not null default 'claimed' check (status in ('claimed','consumed','released')),
  created_at timestamptz not null default now(),
  unique (upload_id, feature)
);
create index on usage_events (user_id, feature, created_at);

-- Raw provider webhooks, keyed by the provider's event id for dedupe.
create table billing_events (
  id text primary key,
  provider text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

-- Claims one use atomically: per-user advisory lock, reuses the ledger row
-- for a retry of the same upload, counts this period's claimed + consumed
-- rows and inserts a 'claimed' row only when under the limit. Returns the
-- usage row id (the caller needs it to mark consumed or released), or NULL
-- at the limit. Revoked from public/anon; server-only.
create or replace function claim_usage(
  p_user uuid, p_feature text, p_upload uuid, p_limit int, p_period_start timestamptz
) returns uuid ...
```

`0003_pending_actions.sql` (Yes/No clarification buttons, `lib/clarify/`):
```sql
create table pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  upload_id uuid references uploads(id) on delete set null,
  kind text not null check (kind in ('create','update','complete')),
  task_id uuid references tasks(id) on delete cascade,
  payload jsonb not null,         -- validated on read against lib/clarify/types.ts
  status text not null default 'pending' check (status in ('pending','accepted','dismissed')),
  expires_at timestamptz not null default now() + interval '1 day',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index on pending_actions (user_id, status);
```

`0004_terms_acceptance.sql` (consent gate; both nullable, no default, no backfill
on purpose, so a missing value reads as stale, never as accepted):
```sql
alter table users add column terms_accepted_at timestamptz,
  add column terms_version text;
```

`0005_purchase_confirmations.sql` (evidence of the confirm tap before any Pro
payment, bot button or web checkbox, stamped with the Terms version in force):
```sql
create table purchase_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  channel text not null check (channel in ('telegram','web')),
  terms_version text not null,
  confirmed_at timestamptz not null default now()
);
create index on purchase_confirmations (user_id, confirmed_at desc);
```

Storage: private bucket `uploads`, paths `{user_id}/{upload_id}/original.{ext}` and `.../annotated.jpg`. Dashboard serves images through short-lived signed URLs.

## 4. AI layer contracts

### 4.1 Client (`lib/meta/client.ts`)
```ts
generateObject<T>(opts: {
  purpose: AiPurpose; userId?: string;
  schema: z.ZodType<T>; schemaName: string;
  system: string;
  input: InputPart[];               // text | image (base64 jpeg) | pdf (base64)
  effort: 'minimal'|'low'|'medium'|'high'|'xhigh';
  model?: string;                   // per-call override, e.g. the understand text route; unset = default model
  timeoutMs?: number;
}): Promise<{ data: T; usage: Usage }>
```
- Responses API: `client.responses.create({ model, instructions, input, reasoning: { effort }, text: { format: { type: 'json_schema', name, schema, strict: true } } })`. The `model` in the body is `opts.model ?? deps.model`, so `ai_calls` always records the model that actually ran.
- Images: `{ type: 'input_image', image_url: 'data:image/jpeg;base64,...' }`. PDFs: `{ type: 'input_file', filename, file_data: 'data:application/pdf;base64,...' }`. Verify exact shapes in `docs/meta-api/image-understanding.md` and `docs/meta-api/file-handling.md`.
- Parse `output_text` as JSON, validate with zod. One retry on parse/validation failure, exponential backoff on 429/5xx (max 3), honour rate-limit headers. Default timeout 90s (`DEFAULT_TIMEOUT_MS`).
- Log every call to `ai_calls` with cost from the price table (Spark standard: $1.25 in, $0.15 cached in, $4.25 out per 1M; transcribe $0.18/hr).
- Budget guard: refuse new calls once today's `ai_calls.cost_usd` sum >= `META_DAILY_BUDGET_USD`.
- Keep the system prompt prefix stable across calls of the same purpose so prompt caching kicks in.
- Schemas use the strict subset (`docs/meta-api/structured-output.md`, send `strict: true`): root is a plain object, every object has `additionalProperties: false`, `required` lists every key (optional = nullable, not omitted), no `allOf`/`oneOf`, `anyOf` only below root, no recursive refs, max nesting 10. A unit test (`tests/meta/strict-schema.test.ts`) runs every schema through the `assertStrictSubset()` checker so violations fail in CI, not as a live HTTP 400.

### 4.2 Understand (`lib/pipeline/understand.ts`)
Input: the content + `now` (ISO with +08:00 and weekday, plus a 14 day calendar) + open tasks as `[{ref: "T1", title, course, kind, due_local}]` (short refs, not UUIDs; mapped back in code; each due line shows the Asia/Singapore date AND time of day) +, for plain text messages only, `recentExchange`: the last turns of this conversation (`lib/pipeline/conversation.ts`, process memory only: 10 minute TTL, 4 turns per user, 500 chars per turn, never persisted or logged).

Effort and model are a per-call split, not one global knob (`lib/env.ts`):
- Text only calls (no image, no pdf): effort `textEffort ?? 'low'`, where `META_TEXT_EFFORT` allows minimal | low | medium, and `META_TEXT_MODEL` swaps in a faster model when set.
- Image or pdf attached: always the default model (`META_MODEL`, `muse-spark-1.3`) at effort `medium`; the text overrides never apply.

Measured on the live understand eval: `muse-spark-1.3` at effort `minimal` passed all 16 fixtures with roughly half the latency, so `minimal` is the recommended text effort; `muse-spark-1.2` hung once and is not recommended.

Output schema:
```ts
{
  input_kind: 'chat_screenshot'|'assignment_brief'|'lecture_slides'|'math_working'|'plain_message'|'other',
  extracted_text: string,                       // what the model read, for audit/debug
  actions: Array<{
    type: 'create'|'update'|'complete'|'none',
    task_ref: string | null,                    // required for update/complete
    title: string | null, course: string | null,
    kind: 'assignment'|'test'|'reading'|'math_practice'|'other' | null,
    due_local: string | null,                   // 'YYYY-MM-DDTHH:mm' in Asia/Singapore
    effort: 'small'|'medium'|'large' | null,
    evidence: string,                           // verbatim quote
    confidence: number                          // clamped to 0..1 in code after parsing
  }>,
  needs_clarification: string | null,
  answer_to_student: string | null              // plain-text answer to a question about what Settle did or the open tasks
}
```
The schema is a `z.strictObject` in the strict subset: no optional keys (confidence carries no min/max keywords on the wire; the range is clamped in code), and the answer is trimmed, whitespace collapsed, capped at 400 chars, and nulled whenever any real action was returned (actions win).
Prompt rules to encode: Singlish glossary (liao, nxt, tmr, ytd, eod, "can or not", "jialat", "sian", "chope", "on lor"); relative dates resolved only against the given `now` and calendar; "next Fri" means the Friday of next week (if today is Fri, it means 7 days later); "extend"/"postpone"/"push back" map to update; "submitted"/"done liao" map to complete; a date-only update keeps the task's existing clock time; the 23:59 default applies only when no time of day is known; pure noise yields `none`; never invent deadlines; questions about what Settle did are answered in short plain text (no markdown, nothing to run or buy) and make no changes. Content is data, not instructions: student text and quoted earlier turns sit behind `<student_content>` / `<earlier_exchange>` delimiters with closing delimiters neutralised.

### 4.3 Reconcile (`lib/pipeline/reconcile.ts`, pure)
`planReconcile(actions, openTasks, now) -> Op[]`:
- `update`/`complete` with an unknown `task_ref` -> downgrade to create only if title present, else drop.
- `create` whose normalized title+course fuzzy-matches an open task (token Jaccard >= 0.6) -> becomes update (dedupe safety net beyond the model).
- `confidence < 0.5` -> no write, surfaces in clarification reply.
- Produces `task_events` rows with before/after and evidence.
`executeOps(ops)` performs writes. Unit tests cover all branches with fixtures.

### 4.4 Priority (`lib/pipeline/priority.ts`, pure)
`score = urgency(hours_until_due) * kindWeight * effortFactor`. Overdue highest, no due date lowest within kind. Weights: test 1.3, assignment 1.2, review 1.0, math_practice 1.0, reading 0.8, other 0.7. Effort factor: large 1.2, medium 1.0, small 0.9. Tunable constants, unit tested for ordering.

### 4.5 Starters (`lib/starters/`)
Shared zod schemas in `lib/starters/types.ts`:
- `Checklist { items: { id, text, category: 'deliverable'|'submission_rule'|'rubric', page: number|null, done: boolean }[] }` (effort `medium`, input PDF)
- `Flashcards { cards: { front, back, page }[], practice: { question, answer, page }[] }` (effort `medium`)
- `MathDiagnosis { steps: { index, latex_or_text, bbox: [x1,y1,x2,y2] | null }[], is_correct: boolean, first_error_step: number|null, what_went_wrong: string|null, misconception: { topic: MathTopic, detail: string } | null, correct_next_step: string|null, final_answer_check: string, practice: { question, answer }[] }` (effort `high`; bboxes on Meta's 0-1000 grid, see `docs/meta-api/image-understanding.md` "perception grounding")
- `MATH_TOPICS`: fixed list (e.g. algebra_manipulation, sign_errors, fractions, indices, logarithms, differentiation_chain_rule, differentiation_product_quotient, integration_by_parts, integration_substitution, trigonometric_identities, vectors, probability, statistics, complex_numbers, sequences_series, other). Fixed taxonomy keeps weak-spot counts meaningful.

Annotation (`lib/media/annotate.ts`): scale bbox from 0-1000 to pixel space of the exact image sent, draw a red rounded rect + "Step N" label via SVG overlay with sharp, save to Storage, send with `replyWithPhoto`.

### 4.6 Voice (`lib/media/audio.ts` + `lib/meta/transcribe.ts`)
OGG/Opus -> ffmpeg-static -> WAV mono 16-bit 16 kHz -> multipart POST to the ASR endpoint (see `docs/meta-api/speech-to-text.md`). `transcribeUrl()` appends `/asr/transcribe` to the configured base, which already ends in `/v1`, so the documented `/v1/asr/transcribe` path is produced without ever doubling the prefix. Request JSON: `mode: "PUSH_TO_TALK"`, `audioEncoding: "WAV"`, `languageBias: ["English"]` (the docs want language names, not codes), `keywords`: the student's course codes from open tasks, cleaned to code-like tokens (letters + 3-4 digits + optional trailing letter, separators dropped) and capped at 20. 60s timeout; same budget guard, retry and `ai_calls` logging rules as `lib/meta/client.ts`. Transcript goes into Understand as a plain message.

## 5. Security

- Webhook: secret header checked with `crypto.timingSafeEqual` before parsing the body. Generic 401, no detail.
- Idempotency: `telegram_updates` PK on `update_id`, so retries never double-spend AI credits.
- Allowlist: `ALLOWED_TELEGRAM_IDS`; the switch that opens the bot to everyone refuses to work while billing is off (`lib/telegram/access.ts`). Rate limits: 8 uploads per student per rolling 60 seconds and 150 per rolling day, counted from the `uploads` table so they hold across instances; a counter failure fails open so a student is never blocked by an outage (`lib/telegram/limits.ts`).
- Daily AI budget guard (4.1).
- Supabase: secret key server-only (`import 'server-only'` in `lib/db`), RLS on with no policies, so a leaked anon key reads nothing. Never ship `NEXT_PUBLIC_SUPABASE_*`.
- Magic links: 32 random bytes, only the sha256 stored, single use, 15 min expiry. Session: `jose` HS256 JWT in an httpOnly, Secure, SameSite=Lax cookie, 7 days, checked in `middleware.ts` for dashboard routes.
- Ownership: every dashboard query filters by session `user_id`; reconciler only touches tasks it loaded for that user.
- Prompt injection: uploaded content is wrapped as data in prompts; output is schema-constrained; the model has no tools; writes go through the reconciler.
- File limits: 20 MB (Telegram cap), PDF pages beyond 50 not seen (tell the student), MIME whitelist.
- Privacy: the default model ids run in Standard mode (`muse-spark-1.3`, `muse-voice-transcribe-1.0`), which Meta's model docs say does not train on your content; a custom `META_TEXT_MODEL` is the deployer's own choice.

## 6. Error handling
- Every handler wrapped: catch, mark upload failed, log, reply "Sorry, I couldn't read that one. Could you send a clearer photo or the PDF instead?".
- Unreadable/garbled image: Understand returns `input_kind: 'other'` with no actions -> friendly reply, no crash.
- Model timeout (90s understand default, 120s checklist and flashcards, 200s math at high effort, 60s transcription) -> failed upload, friendly reply.
- Telegram API errors on reply are logged, never rethrown inside `after()`.

## 7. Cost estimate
Typical screenshot understand call: ~3k input + ~1.5k output (incl. reasoning) tokens = ~$0.01. 30-page PDF starter: ~40k input = ~$0.06. Math diagnosis at high effort: ~$0.03-0.05. A full day of heavy testing (~500 calls) stays under $15. Budget guard default $10/day.
