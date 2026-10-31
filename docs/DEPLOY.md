# Deploying Settle on your own server

Production for Settle is a plain VPS running Docker: one app container plus Caddy for automatic HTTPS. This runbook goes from a fresh machine to a working bot and dashboard. The Vercel deployment stays a demo only (note at the end).

## What you need

- A VPS with Docker and the Docker Compose plugin (Ubuntu 24.04 is fine, 1 vCPU and 1 GB RAM to start).
- A domain you control, so you can point an A record at the server (the examples use `settle.example.com`).
- A Supabase project (Project Settings, API and Database tabs).
- A Telegram bot token from @BotFather.
- A Meta Model API key from dev.meta.ai.
- Any machine with bun installed for the one-shot webhook script (your laptop is fine).

## Environment variables

All configuration is runtime env, read from one file. Nothing secret goes into the image or the build.

| Name | Required | What it is |
| --- | --- | --- |
| TELEGRAM_BOT_TOKEN | yes | Bot token from @BotFather. |
| TELEGRAM_BOT_USERNAME | yes | Bot username without the @, used for the dashboard links. |
| TELEGRAM_WEBHOOK_SECRET | yes | Random string Telegram echoes back on every webhook call. Generate with `openssl rand -hex 32`. |
| ALLOWED_TELEGRAM_IDS | yes | Comma-separated numeric Telegram user IDs allowed to use the bot. Keep the allowlist on until launch. |
| ALLOWLIST_ENABLED | no | Set `false` only at the launch switch to open the bot to everyone. Ignored (the allowlist stays on) while `BILLING_ENABLED` is `false`. |
| MODEL_API_KEY | yes | Meta Model API key from dev.meta.ai. |
| META_API_BASE_URL | no | Meta API base URL, defaults to `https://api.meta.ai/v1`. |
| META_MODEL | no | Defaults to `muse-spark-1.3`. |
| META_TRANSCRIBE_MODEL | no | Defaults to `muse-voice-transcribe-1.0`. |
| META_DAILY_BUDGET_USD | no | Hard daily stop for AI spend in USD, default 10. |
| SUPABASE_URL | yes | Project URL from Supabase Project Settings, API tab. |
| SUPABASE_SECRET_KEY | yes | The `sb_secret_...` key (or legacy service role key). Server only, never in the browser. |
| SUPABASE_STORAGE_BUCKET | no | Storage bucket name, defaults to `uploads`. |
| SUPABASE_DB_URL | yes | Postgres connection string, needed to apply migrations. |
| SESSION_SECRET | yes | Signs dashboard session cookies. Generate with `openssl rand -hex 32`. |
| APP_BASE_URL | yes | The public https URL, `https://settle.example.com`. Used in magic links and webhook registration. The script refuses localhost and non-https. |
| BILLING_ENABLED | no | Keep `false` until the launch switch; with false everyone is treated as Pro. |
| STRIPE_SECRET_KEY | no | Stripe secret key. Test mode first (`sk_test_...`). Blank keeps `/billing` closed. |
| STRIPE_WEBHOOK_SECRET | no | Signing secret (`whsec_...`) of the `/api/stripe/webhook` endpoint. |
| STRIPE_PRICE_PRO_MONTHLY | no | Recurring monthly price id for Pro. |
| STRIPE_PRICE_PRO_YEARLY | no | Recurring yearly price id for Pro. |
| STRIPE_PRICE_PRO_YEARLY_PAYNOW | no | One-time yearly price id; enables the PayNow button on `/billing`. |

Generate the two secrets:

```
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # TELEGRAM_WEBHOOK_SECRET
```

## The env file

Keep production values in one file outside the repo on the server, readable only by you:

```
# on your laptop
nano settle.env                # fill from the table above
chmod 600 settle.env
scp settle.env you@your-server:/opt/settle.env
```

The sample `deploy/docker-compose.yml` points at `/opt/settle.env`. Change that path if you keep the file elsewhere. Never commit it; the Dockerfile never copies it and `.dockerignore` blocks env files from the build context.

## Database

1. Open the Supabase SQL editor and run the three migration files in order, one at a time:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_billing.sql`
   - `supabase/migrations/0003_pending_actions.sql`

   0002 creates the billing tables that sit dormant behind `BILLING_ENABLED=false` (the usage ledger writes from day one), so apply all three. Alternative: `supabase link` then `supabase db push` using `SUPABASE_DB_URL`.
2. Create the private `uploads` bucket. The SQL way, in the same editor:

```sql
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;
```

## DNS, firewall, first deploy

1. DNS: create an A record `settle.example.com` pointing at the server IP and wait for it to resolve.
2. Firewall: only SSH, HTTP and HTTPS in.

```
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

3. Get the code onto the server without any env file (`git clone` or rsync the repo) to `/opt/settle`.
4. Build and start both containers.

```
cd /opt/settle
docker compose -f deploy/docker-compose.yml up -d --build
```

Caddy fetches a Let's Encrypt certificate for the domain on first request and renews it from then on. The app container is not published to the host; only Caddy's 80 and 443 are. The compose services look like this (full file in `deploy/`):

```
services:
  app:
    build: ..
    image: settle:latest
    restart: unless-stopped
    env_file:
      - /opt/settle.env
    expose:
      - "3000"
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
```

5. Check it.

```
docker compose -f deploy/docker-compose.yml ps     # app should show (healthy)
curl -s https://settle.example.com/api/health      # {"ok":true}
```

Plain docker without compose works too (`docker build -t settle .` then `docker run -d --name settle -p 127.0.0.1:3000:3000 --env-file /opt/settle.env settle`), but then you must bring your own TLS in front; compose plus Caddy is the supported path.

## Point Telegram at the server

Once https answers, register the webhook from any machine with bun and the production values:

```
bun --env-file=/opt/settle.env run scripts/set-webhook.ts
```

(On an older bun: copy `/opt/settle.env` to `.env` in a repo checkout, run `bun run scripts/set-webhook.ts`, then delete `.env`.)

The script registers `APP_BASE_URL` with the secret and the allowed updates list from `lib/telegram/callbacks.ts`. That list covers callback_query (the clarification buttons); when Telegram Stars lands, keep the payment update types in the same list and re-run the script.

Re-run the script after any `APP_BASE_URL` or domain change; Telegram keeps calling the old URL otherwise.

Quick tunnels such as `cloudflared tunnel --url` are for local testing only: their URL changes every run, which would break `APP_BASE_URL` and the webhook.

## Smoke test checklist

Run through this after the first deploy and after any domain move:

- [ ] `curl -s https://settle.example.com/api/health` returns `{"ok":true}`.
- [ ] The landing page opens over https with no certificate warning.
- [ ] `/start` in Telegram gets a reply.
- [ ] Sending a screenshot or PDF creates a task and the bot confirms.
- [ ] The `/dashboard` command's link opens over https and the magic link logs you in.
- [ ] A webhook call without the secret is refused.

```
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://settle.example.com/api/telegram \
  -H "content-type: application/json" -d '{}'
# expect 401
```

## Updating

```
cd /opt/settle
docker tag settle:latest settle:previous        # keep the last good image
git pull                                        # or rsync the new code up
docker compose -f deploy/docker-compose.yml up -d --build
```

If a new migration file exists, run it in the Supabase SQL editor before or right after the deploy. Re-run the webhook script only if the URL changed.

## Rollback

```
docker tag settle:previous settle:latest
docker compose -f deploy/docker-compose.yml up -d --force-recreate app
```

## Logs

```
docker compose -f deploy/docker-compose.yml logs -f app
docker compose -f deploy/docker-compose.yml logs -f caddy
```

Rotation is configured in the compose file (10 MB per file, 3 files per service), so logs cannot fill the disk.

## Backups

The data lives in Supabase, not on the VPS. In the Supabase dashboard, Backups shows scheduled backups; paid plans add point-in-time recovery. On the free plan, take a manual dump before big changes:

```
pg_dump "$SUPABASE_DB_URL" > settle-backup.sql
```

Storage files in the `uploads` bucket are not in `pg_dump`; export them from the Supabase dashboard if the bucket contents matter.

## Security checklist

- The env file sits outside the repo with `chmod 600`; it is the only place secrets exist.
- The firewall lets in 22, 80 and 443 only. The app container is not published to the host; Caddy is the single entry point.
- `ALLOWED_TELEGRAM_IDS` stays on until launch.
- `META_DAILY_BUDGET_USD` stays set so a runaway loop cannot spend.
- `BILLING_ENABLED` stays `false` until the launch switch.
- No secrets in the image: the build takes no arguments and the final stage copies only the built output.

## Stripe (web payments, test mode first)

Settle sells Pro on the website through Stripe Checkout; Telegram Stars covers the bot. Nothing here charges real money until you switch to live keys. All five variables are optional: with any of them blank, `/billing` shows that paid plans are not open yet and nothing can be bought. The code is identical for test and live; only the env values change.

### One-time setup in the Stripe dashboard (test mode)

1. Log in to [dashboard.stripe.com](https://dashboard.stripe.com) with test mode on (the toggle sits next to the search box).
2. Product catalogue, add a product `Settle Pro` with two recurring prices in SGD:
   - `7.99` per month, and
   - `63.99` per year.
   Copy both price ids (they start with `price_`). They go into `STRIPE_PRICE_PRO_MONTHLY` and `STRIPE_PRICE_PRO_YEARLY`.
3. For PayNow, add a one-time price on the same product: `63.99`, one time (no recurring). Copy its price id into `STRIPE_PRICE_PRO_YEARLY_PAYNOW`. PayNow cannot recur, so the web page offers the yearly plan as a single charge. Leave the variable blank to hide the PayNow button.
4. Developers, Webhooks, add an endpoint with URL `https://<domain>/api/stripe/webhook` and exactly these events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
5. Copy the test secret key (`sk_test_...`) into `STRIPE_SECRET_KEY`.

While the secret key starts with `sk_test_`, `/billing` shows a small "Test mode, no real charges" sticker. Test cards: `4242 4242 4242 4242` succeeds; PayNow test sessions show a QR that can be simulated from the Stripe dashboard.

### Local testing without a public URL

`stripe listen` forwards Stripe events to localhost and prints a per-run signing secret:

```
stripe listen --forward-to localhost:3000/api/stripe/webhook
# copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET, then restart the app
stripe trigger checkout.session.completed
```

Use `APP_BASE_URL=http://localhost:3000` locally; the success and cancel redirects come from it.

### Switching to live

When you are ready to charge for real: activate your Stripe account, flip the dashboard to live mode, create the same product and prices there, add a live webhook endpoint with the same four events, then replace all five env values (`sk_live_...`, the live `whsec_...`, the live price ids) in the server env file and restart the container. No code changes.

The webhook needs the raw request body, so do not put a transforming proxy between Caddy and the app.

## Note on Vercel

The Vercel deployment (`settlenotes.vercel.app`) is the hackathon demo only: Vercel Hobby is non-commercial. Real production runs from this runbook.
