-- Evidence that a student confirmed before paying for Pro: one row per tap of
-- the purchase confirm button, on Telegram (pc:ok callback) or on the web
-- billing page (checkbox), stamped with the Terms version in force at the
-- tap. Written and read by lib/billing/purchase-consent.ts. This is a
-- representation the student makes; no age is asked for or stored.

create table purchase_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  channel text not null check (channel in ('telegram','web')),
  terms_version text not null,
  confirmed_at timestamptz not null default now()
);
create index on purchase_confirmations (user_id, confirmed_at desc);

-- RLS on everything, no policies: only the service role (server) can touch
-- data, same as 0001.
alter table purchase_confirmations enable row level security;
