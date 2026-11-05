-- Google Calendar sync state for Pro users (T40a library layer only).
-- calendar_connections holds the encrypted OAuth refresh token and the id of
-- the dedicated "Settle" calendar created under the app.created scope.
-- calendar_event_links maps open tasks to the Google events written for them.
-- Both tables carry the refresh token ciphertext, never plaintext.

create table calendar_connections (
  user_id uuid primary key references users(id) on delete cascade,
  google_calendar_id text,
  refresh_token_enc text,
  status text not null check (status in ('active','needs_reconnect')),
  sync_lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table calendar_event_links (
  task_id uuid primary key references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  google_event_id text not null,
  synced_hash text not null,
  synced_at timestamptz not null default now()
);
create index on calendar_event_links (user_id);

-- RLS on everything, no policies: only the service role (server) can touch
-- data, same as 0001 and 0005.
alter table calendar_connections enable row level security;
alter table calendar_event_links enable row level security;
