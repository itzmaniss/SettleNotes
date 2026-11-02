# Where student data lives, and how it goes away

One page for the operator and for counsel. Every statement below can be checked against this repository. Anything this document cannot verify from the repository carries a bracketed note instead of a guess. The erase script is `scripts/delete-user.ts` (library in `lib/privacy/`), the export script is `scripts/export-user.ts`, the stale account sweep is `scripts/stale-accounts.ts`.

## Where student data lives

| Place | What is there | How long | How it is removed |
| --- | --- | --- | --- |
| Supabase database | The account row (Telegram id, chat id, first name, timezone, terms acceptance). Upload records (what kind of file, extracted text, classification). Tasks and their change history. Generated study material (checklists, flashcards, math diagnosis, review practice). Weak spot notes. Subscription rows (provider and subscription id, plan, status). The usage quota ledger. One time dashboard login links. AI call cost records (tokens and cost; no prompt or reply text is stored). Raw payment webhook payloads, keyed by event id for dedupe. Webhook dedupe ids. Clarification buttons parked for a Yes or No tap. Purchase confirmations: which surface a student confirmed on, and when, before a Pro payment. | Until the student asks for erasure, or the operator erases an abandoned account after review (retention proposal under Open decisions). Clarification buttons expire after a day by default; login links carry their own expiry. | `scripts/delete-user.ts` scrubs the payment payloads, then deletes the account row; the database cascade removes the rows that belong to it. AI call cost records stay for accounting with the student link removed. The Supabase project region: [confirm in Supabase dashboard]. |
| Supabase storage bucket `uploads` | The original files students send and the annotated images produced from them, under paths `<user id>/<upload id>/`. The bucket is private. | Until erasure. | The erase script lists everything under the student's `<user id>/` prefix, deletes it in batches, then verifies the prefix is empty. |
| Telegram | The conversation with the bot, including the student's own messages, lives in the student's own Telegram account. Settle cannot delete it. Settle stores Telegram file ids only so it can re-download a file the student sent. | In Telegram's and the student's hands, not Settle's. | Not removable by Settle. A student who wants the chat gone deletes it in their own Telegram app. |
| Meta model API | Images, message text and voice audio are sent to the model API so they can be classified, transcribed and turned into study material. | Meta's own retention terms apply; Settle does not control them. The counsel pack in docs/legal holds the quoted terms. | Settle sends nothing and asks for nothing at erasure time. Whatever Meta keeps is governed by Meta's terms. |
| Stripe | Checkout and customer portal data sit on Stripe's side. Settle's own database stores only the Stripe subscription ids (`sub_...`) on the student's subscription rows, and no Stripe customer id anywhere. | Stripe keeps customer and payment records for its own legal needs. | The erase script never contacts Stripe. It reports the subscription ids it saw before deleting, so the operator can find the student's records in the Stripe dashboard if the student asks. Removing them there is a manual dashboard job, only if accounting rules allow. |
| Telegram Stars payments | Telegram keeps its own payment record; Settle cannot change that. Settle's copy is the webhook payload, scrubbed at erasure down to amount, currency, dates and the Stars charge id. | Settle's copy: kept for accounting and refund support, with identifying fields removed at erasure. Telegram's copy: Telegram's. | At erasure the payload loses the user and Telegram ids; the charge id stays so refunds and support still work. The subscription row itself is deleted by the cascade. |
| VPS container logs | The app and Caddy containers write logs on the VPS. They can contain Telegram ids, event ids and timestamps. Caddy writes no separate access log file: `deploy/Caddyfile` has no `log` directive, so Caddy's messages land in the same container logs. | Rotated at 10 MB per file, 3 files per service, so old content scrolls away on its own. | Rotation only. If an incident ever puts more than ids and timestamps into the logs, cleanup after the incident is the operator's job (see docs/INCIDENT.md). |
| Manual database dumps | Whatever the operator copies out with `pg_dump` (docs/DEPLOY.md, Backups). A dump is a full copy of the database at that moment, so it contains everything in the first row of this table. | Rule: delete each dump within 30 days (proposed; confirm with counsel). | By hand, by the operator. If a dump was kept longer, or was restored, every erasure that happened since it was taken must be applied to it again, so a deleted student stays deleted. |
| App process memory | Short term chat memory: the last few messages of an ongoing conversation, held in the app's memory for 10 minutes only, never written to the database, lost on restart. | 10 minutes, or until the app restarts, whichever comes first. | Nothing to remove: it is never written to the database or to any file, and it disappears when the process stops. |

## What the erase script removes and what it keeps

Run the delete script as a dry run first (`bun run scripts/delete-user.ts --telegram-id <id>`), read the counts, then add `--yes`.

Removes:

- The account row and, through the database cascade, the upload records, tasks, task history, study material, weak spots, subscription rows, usage ledger rows, login links, clarification buttons and purchase confirmations.
- Every stored file under the student's `<user id>/` prefix in the `uploads` bucket.

Minimises (rows that stay for accounting and webhook dedupe):

- Stars payment payloads keep amount, currency, dates and the Stars charge id, and lose the user and Telegram ids.
- Stripe payment payloads keep only the event type and object id, and lose the user id.
- Refund bookkeeping rows keep only the charge id.

Keeps:

- AI call cost records (tokens and cost, no prompt or reply text) with the student link removed, so spend history still adds up.

Captured at erase time: the Stripe subscription ids the student ever had, read before the account row goes. The script prints them afterwards with the reminder that Stripe keeps its own record for tax and accounting, and that removing it there (only if the student asked and accounting rules allow) is done by hand in the Stripe dashboard, never by Settle.

## Backups

The Supabase free plan has no automatic backups. The owner confirmed this for this deployment. Both consequences, stated plainly:

- The good side: when the erase script removes an account, the data is gone from the live system at once, and there is no backup copy waiting to age out on a schedule.
- The cost: nothing can be recovered after a mistake or an outage. A dropped table, a bad migration or a cleared bucket is gone for good.

The only copies of the data are the dumps the operator takes by hand. Rules for manual dumps:

- Store each dump outside the repository and outside synced folders (no Dropbox, no iCloud Drive, no Google Drive).
- Keep the file owner only: `chmod 600`.
- Delete each dump within 30 days (proposed; confirm with counsel).
- If a dump was kept longer, or a dump was restored, re-apply every erasure that happened since the dump was taken.

Because there are no backups: take a fresh dump before risky changes (migrations, bulk edits) and delete it on the schedule above.

## Open decisions for the owner and counsel

None of these are decided. They are the proposals this page leaves open, for the owner and counsel to confirm or change:

1. Retention for abandoned accounts. Proposed: 365 days of no activity puts an account on the review list (`bun run scripts/stale-accounts.ts --days 365`, run once a quarter), and a human reviews before any erase. An account on the list is a prompt to look, never an instruction to erase.
2. Deadline for completing a verified request. Proposed: 30 days from the request. That sits inside the 60 days the draft privacy notice in docs/legal mentions, so adopting it keeps the public notice honest.
3. Manual dump retention. Proposed: 30 days, per the rules above.
4. Reuse of study material. Not built, and off: nothing a student sends is retained or reused for training or product improvement. If that ever changes, this page, the privacy notice and the terms have to change first.
