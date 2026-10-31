-- Affirmative acceptance of the Terms and the Privacy Policy, captured before
-- a user row is created or a payment starts (see lib/telegram/consent.ts and
-- app/accept). Both columns are nullable with no default and no backfill on
-- purpose: people who already have a row are asked to accept again through the
-- bot or the /accept page, and lib/legal/consent.ts treats a missing value as
-- "stale", never as accepted.

alter table users add column terms_accepted_at timestamptz,
  add column terms_version text;
