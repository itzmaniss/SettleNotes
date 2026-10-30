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
