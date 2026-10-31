-- Billing seams: subscriptions, the usage ledger and webhook dedupe.
-- Written for the post-hackathon Free/Pro plans, but usage is recorded from
-- day one (behind BILLING_ENABLED=false) so limits get set from real numbers.

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

-- Raw provider webhooks, keyed by the provider's event id for dedupe (T21).
create table billing_events (
  id text primary key,
  provider text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

-- Claims one use of a feature atomically. Takes a per-user advisory lock so
-- two messages from the same student in the same second serialise, reuses the
-- ledger row for a Telegram retry of the same upload, then counts this
-- period's claimed + consumed rows and inserts a 'claimed' row only when the
-- count is under the limit. Returns the usage row id, or NULL when the student
-- is at their limit; the caller needs the id to mark the row consumed or
-- released later. A NULL p_upload skips the dedupe branch and always counts.
create or replace function claim_usage(
  p_user uuid,
  p_feature text,
  p_upload uuid,
  p_limit int,
  p_period_start timestamptz
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_status text;
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));

  if p_upload is not null then
    select id, status into v_id, v_status
    from usage_events
    where upload_id = p_upload and feature = p_feature;
    if found then
      -- Same upload again: a claimed or consumed row is returned as is, and
      -- a released row (the AI call failed last time) is reclaimed in place.
      if v_status = 'released' then
        update usage_events set status = 'claimed' where id = v_id;
      end if;
      return v_id;
    end if;
  end if;

  select count(*) into v_count
  from usage_events
  where user_id = p_user
    and feature = p_feature
    and created_at >= p_period_start
    and status in ('claimed','consumed');

  if v_count >= p_limit then
    return null;
  end if;

  insert into usage_events (user_id, feature, upload_id)
  values (p_user, p_feature, p_upload)
  returning id into v_id;
  return v_id;
end;
$$;

-- RLS on everything, no policies: only the service role (server) can touch
-- data, same as 0001.
alter table subscriptions enable row level security;
alter table usage_events enable row level security;
alter table billing_events enable row level security;

-- The claim function is server-only. 'public' exists on every Postgres; the
-- Supabase roles may not exist on a plain local database, so that part is
-- guarded and silently skipped there.
revoke all on function claim_usage(uuid, text, uuid, int, timestamptz) from public;
do $$
begin
  revoke all on function claim_usage(uuid, text, uuid, int, timestamptz) from anon, authenticated;
exception
  when undefined_object then null;
end $$;
