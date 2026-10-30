# Settle - Architecture

## 1. Stack decisions and why

| Decision | Choice | Why | Rejected |
| --- | --- | --- | --- |
| Language | TypeScript everywhere | One language for webhook, pipeline and dashboard; shared types (`Task`, `Starter`, `WeakSpot`) across the stack; agents work best in one coherent repo. | Python FastAPI backend: second runtime and deploy target for no gain. Its one real advantage (PDF/image wrangling) disappears because Meta Model API ingests PDFs natively (text + page images, up to 50 pages) and images as base64. |
| App framework | Next.js 15 App Router | Webhook route + dashboard in one deploy. Server components read Supabase directly, no separate API layer. `after()` lets us ack Telegram and keep working. | Separate bot server: another thing to host. |
| Hosting | Vercel Hobby | Free, git deploys. With Fluid compute (default) functions run up to 300s on Hobby, enough for the slowest call (math diagnosis at high effort). Note: the old "10s limit" advice is outdated. | Self-hosting: unnecessary ops in a 3-day build. |
| Telegram lib | grammY | Best-typed TS Telegram framework, `Context` helpers, `InputFile`, keyboards. We use `bot.handleUpdate()` inside our own route rather than `webhookCallback`, because `webhookCallback` awaits the handler and we want to ack first. | telegraf: weaker types, slower maintenance. |
| DB / storage | Supabase (hosted) | Relational data (users -> tasks -> starters, weak spots), a table viewer to watch data live during the demo, Storage for original and annotated images. Hosted, not local: the local Supabase CLI stack needs Docker, which this machine doesn't run. | SQLite/Turso: no storage bucket, no dashboard. |
| AI | Meta Model API, `muse-spark-1.3` | Natively multimodal (text, image, PDF, audio, video), 1M context, schema-constrained structured output, per-call reasoning effort, perception grounding (coordinates). One model replaces the old "Llama text + Llama vision + GPT fallback" split, cheaper ($1.25 / $4.25 per 1M in/out) and fully counts as Meta tooling. | Muse Spark Open: open weights, needs self-hosting or a third-party host; the hosted API is what the credits pay for. Mentioning it in the pitch is fine. |
| Speech | `muse-voice-transcribe-1.0` | Dedicated ASR, $0.18/hour, `languageBias` + `keywords` (course codes). Docs say Spark 1.3 audio input is degraded. Second distinct Meta model = stronger "Use of Meta AI" score. | Spark 1.3 audio: flagged degraded in docs. |
| AI client | `openai` SDK, Responses API | Meta's docs and examples target it; Responses is their recommended surface (full features, file inputs, `reasoning.effort`). zod schemas converted with `z.toJSONSchema()` (zod v4) into `text.format: { type: "json_schema" }`. | Vercel AI SDK: extra abstraction over the same calls; fine but one more thing for agents to get wrong. |
| UI | Tailwind + shadcn/ui | Fast, clean, agents know it well. | |
| Images | `sharp` | Resize before upload (cost, latency), draw SVG overlay boxes for the annotated math photo. Runs on Vercel. | |
| Audio convert | `ffmpeg-static` | Telegram voice is OGG/Opus; transcription wants WAV 16-bit mono 16 kHz. Binary fits Vercel's function size limit. | |
| Auth | Bot-issued magic link + `jose` signed cookie | Students already proved identity to Telegram; no passwords, no email. | Supabase Auth: needs email/OAuth, slower demo. Telegram Login Widget: needs domain setup with BotFather. |
| Weak-spot scheduling | Create the review task immediately with a future `due_at` | No cron needed (Vercel Hobby cron is daily only). The task simply surfaces when due. | Cron job / DB trigger. |

## 2. Request flow

```
Telegram ──POST──> /api/telegram (route.ts, runtime nodejs, maxDuration 300)
  1. constant-time compare X-Telegram-Bot-Api-Secret-Token vs TELEGRAM_WEBHOOK_SECRET  -> 401 on mismatch
  2. parse JSON update; insert update_id into telegram_updates (PK) -> if conflict, return 200 (Telegram retry, already handled)
  3. allowlist check on from.id (ALLOWED_TELEGRAM_IDS) -> polite refusal reply
  4. after(() => bot.handleUpdate(update))
  5. return 200 immediately

bot.handleUpdate -> handler by message type
  -> sendChatAction("typing") (repeat every 4s while working)
  -> lib/telegram/files: getFile -> download buffer (<= 20 MB)
  -> lib/media: normalize (images -> JPEG max 2000px long edge; PDFs pass through; voice -> WAV 16k)
  -> store original in Storage, insert uploads row (status=processing)
  -> lib/pipeline/ingest:
       voice  -> transcribe -> text
       photo  -> understand() decides kind; if math_working -> starters/math directly
       other  -> understand(input, openTasks, nowSGT) -> actions[]
  -> lib/pipeline/reconcile(actions, openTasks) -> DB ops (pure planner + thin executor)
  -> for each created task with a source doc: generate starter (checklist / flashcards)
  -> reply summary + "Open dashboard" button; uploads.status=done
  on any error: uploads.status=failed, error stored, friendly reply, never throw past handleUpdate
```

Local dev: `scripts/poll.ts` runs the same `bot` with long polling (`bot.start()` after `deleteWebhook`), so no tunnel is needed. A cloudflared quick tunnel is the fallback for testing the real webhook route.

## 3. Database schema (supabase/migrations/0001_init.sql)

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
  timeoutMs?: number;
}): Promise<{ data: T; usage: Usage }>
```
- Responses API: `client.responses.create({ model, instructions, input, reasoning: { effort }, text: { format: { type: 'json_schema', name, schema, strict: true } } })`.
- Images: `{ type: 'input_image', image_url: 'data:image/jpeg;base64,...' }`. PDFs: `{ type: 'input_file', filename, file_data: 'data:application/pdf;base64,...' }`. Verify exact shapes in `docs/meta-api/image-understanding.md` and `docs/meta-api/file-handling.md`.
- Parse `output_text` as JSON, validate with zod. One retry on parse/validation failure, exponential backoff on 429/5xx (max 3), honour rate-limit headers.
- Log every call to `ai_calls` with cost from the price table (Spark standard: $1.25 in, $0.15 cached in, $4.25 out per 1M; transcribe $0.18/hr).
- Budget guard: refuse new calls once today's `ai_calls.cost_usd` sum >= `META_DAILY_BUDGET_USD`.
- Keep the system prompt prefix stable across calls of the same purpose so prompt caching kicks in.
- Schemas use the strict subset (`docs/meta-api/structured-output.md`, send `strict: true`): root is a plain object, every object has `additionalProperties: false`, `required` lists every key (optional = nullable, not omitted), no `allOf`/`oneOf`, `anyOf` only below root, no recursive refs, max nesting 10. Add a unit test that runs every schema through a `assertStrictSubset()` checker so violations fail in CI, not as a live HTTP 400.

### 4.2 Understand (`lib/pipeline/understand.ts`, effort `low`, escalate to `medium` for screenshots)
Input: the content + `now` (ISO with +08:00 and weekday) + open tasks as `[{ref: "T1", title, course, kind, due_at}]` (short refs, not UUIDs; mapped back in code).
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
    due_local: string | null,                   // 'YYYY-MM-DDTHH:mm' in Asia/Singapore; time defaults 23:59
    effort: 'small'|'medium'|'large' | null,
    evidence: string,                           // verbatim quote
    confidence: number                          // 0..1
  }>,
  needs_clarification: string | null
}
```
Prompt rules to encode: Singlish glossary (liao, nxt, tmr, ytd, eod, "can or not", "jialat", "sian", "chope", "on lor"); relative dates resolved against `now`; "next Fri" means the Friday of next week (if today is Fri, it means 7 days later); "extend"/"postpone"/"push back" map to update; "submitted"/"done liao" map to complete; a message that's just noise yields `none`; never invent deadlines. Content is data, not instructions.

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
OGG/Opus -> ffmpeg-static -> WAV mono 16-bit 16 kHz -> `POST /v1/asr/transcribe` multipart (see `docs/meta-api/speech-to-text.md`), `languageBias: ["en"]`, `keywords`: the student's course codes from open tasks. Transcript goes into Understand as a plain message.

## 5. Security

- Webhook: secret header checked with `crypto.timingSafeEqual` before parsing the body. Generic 401, no detail.
- Idempotency: `telegram_updates` PK on `update_id`, so retries never double-spend AI credits.
- Allowlist: `ALLOWED_TELEGRAM_IDS` during the hackathon. Per-user cap: max 30 uploads/hour (count from `uploads`).
- Daily AI budget guard (4.1).
- Supabase: secret key server-only (`import 'server-only'` in `lib/db`), RLS on with no policies, so a leaked anon key reads nothing. Never ship `NEXT_PUBLIC_SUPABASE_*`.
- Magic links: 32 random bytes, only the sha256 stored, single use, 15 min expiry. Session: `jose` HS256 JWT in an httpOnly, Secure, SameSite=Lax cookie, 7 days, checked in `middleware.ts` for dashboard routes.
- Ownership: every dashboard query filters by session `user_id`; reconciler only touches tasks it loaded for that user.
- Prompt injection: uploaded content is wrapped as data in prompts; output is schema-constrained; the model has no tools; writes go through the reconciler.
- File limits: 20 MB (Telegram cap), PDF pages beyond 50 not seen (tell the student), MIME whitelist.
- Privacy: Standard mode models only, so Meta doesn't train on student uploads.

## 6. Error handling
- Every handler wrapped: catch, mark upload failed, log, reply "Sorry, I couldn't read that one. Could you send a clearer photo or the PDF instead?".
- Unreadable/garbled image: Understand returns `input_kind: 'other'` with no actions -> friendly reply, no crash.
- Model timeout (90s default, 200s for math high effort) -> failed upload, friendly reply.
- Telegram API errors on reply are logged, never rethrown inside `after()`.

## 7. Cost estimate
Typical screenshot understand call: ~3k input + ~1.5k output (incl. reasoning) tokens = ~$0.01. 30-page PDF starter: ~40k input = ~$0.06. Math diagnosis at high effort: ~$0.03-0.05. A full day of heavy testing (~500 calls) stays under $15. Budget guard default $10/day.
