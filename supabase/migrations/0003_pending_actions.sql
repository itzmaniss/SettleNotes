-- Low-confidence actions parked for a Yes/No tap. One row per clarification
-- button: the tap claims the row (accepted or dismissed) exactly once, and
-- payload holds just enough to apply the action later. The shape of payload
-- is validated on read against the zod schemas in lib/clarify/types.ts.

create table pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  upload_id uuid references uploads(id) on delete set null,
  kind text not null check (kind in ('create','update','complete')),
  task_id uuid references tasks(id) on delete cascade,
  payload jsonb not null,         -- create: title/course/kind/dueAt/effort/evidence, update: dueAt/title/evidence, complete: evidence
  status text not null default 'pending' check (status in ('pending','accepted','dismissed')),
  expires_at timestamptz not null default now() + interval '1 day',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index on pending_actions (user_id, status);

-- RLS on everything, no policies: only the service role (server) can touch
-- data, same as 0001.
alter table pending_actions enable row level security;
