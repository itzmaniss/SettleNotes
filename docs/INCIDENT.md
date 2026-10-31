# Incident runbook

One page, for the worst hour. Work top to bottom. This file is practical, not legal advice: when a breach may be notifiable, check the PDPC's current guidance at https://www.pdpc.gov.sg and call counsel.

## 1. What counts as an incident

- A key or token leaked: anything from the env file, a bot token, a Stripe key, a screenshot of a secret, a value pasted into a public place.
- The database or the storage bucket exposed to people who should not see it.
- Someone saw another student's data: a wrong reply, a shared link, a screenshot with someone else's task in it.
- A device with the env file (or with real values written down) is lost or stolen.
- Suspicious Stripe or Telegram activity: payments or refunds you cannot place, logins or webhook calls you do not expect.

## 2. First 30 minutes, in this order

1. **Stop the bleeding.** Close the bot to strangers: set `ALLOWLIST_ENABLED=true` in `/opt/settle.env` and restart the app:

```
docker compose -f deploy/docker-compose.yml up -d --force-recreate app
```

Existing students keep their sessions and subscriptions; new strangers cannot talk to the bot.

2. **Revoke and rotate, in this order.** One at a time, oldest compromise first.
   1. `TELEGRAM_BOT_TOKEN`: @BotFather, /revoke, put the new token in the env file.
   2. `SUPABASE_SECRET_KEY`: Supabase, Project Settings, API, publish a new secret key and retire the old one. Rotate the database password in the Supabase dashboard too, and update `SUPABASE_DB_URL` if it held the password.
   3. `MODEL_API_KEY`: dev.meta.ai, API keys, create a new key, delete the old one.
   4. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: Stripe dashboard, Developers, roll the secret key, then roll the webhook endpoint's signing secret.
   5. `SESSION_SECRET`: new `openssl rand -hex 32`. Rotating it signs every dashboard session out at once. That is intended.
   6. `TELEGRAM_WEBHOOK_SECRET`: new `openssl rand -hex 32`, then register the webhook again and restart:

```
bun --env-file=/opt/settle.env run scripts/set-webhook.ts
docker compose -f deploy/docker-compose.yml up -d --force-recreate app
```

3. **Preserve evidence.** Copy the container logs somewhere safe before they disappear:

```
docker compose -f deploy/docker-compose.yml logs app > incident-app.log
```

Keep timestamps. Do not delete anything, including rows that look compromised. Do not wipe the device.

4. **Write down times.** When you noticed, what you saw, when you rotated each key, when you restarted. You will need them for the post-mortem and for any notification.

## 3. Assess the blast radius

- What data: tokens? contact details? task content? uploads that show other people?
- How many students are affected?
- Is the data likely to cause significant harm to them? Private messages, contact details and other people's names in screenshots weigh heavily.
- Does it reach 500 or more people? Scale alone can make a breach notifiable.

## 4. Notify (PDPA)

- If the breach is likely to cause significant harm to the affected people, or affects 500 or more people, it is likely notifiable: tell the PDPC as soon as practicable, and no later than three calendar days after you determine it is notifiable.
- Tell affected students quickly when significant harm is likely: what happened, what data, what they should do.
- This is a prompt, not a legal conclusion. Check the PDPC's current guidance at https://www.pdpc.gov.sg and contact counsel before deciding anything.

## 5. After the fire is out

- Rotate whatever is left: any Meta, Supabase, Stripe, Telegram, session or webhook secret not covered above.
- Write a short post-mortem: what happened, when, what data, what you did, what changes.
- Fix the cause: where the value leaked, what surface was exposed, which check was missing.
- Watch for follow-up abuse for a few weeks: SSH attempts on the VPS, odd Stripe disputes, strange Telegram accounts.

## 6. Contacts

Fill these in before you need them:

| Who | Contact |
| --- | --- |
| Operator (you) | [mobile] |
| Counsel | [name, phone, email] |
| VPS provider support | [provider, support URL or ticket link] |
| Supabase support | [support URL, plan] |
| Stripe support | [support URL, account id] |
