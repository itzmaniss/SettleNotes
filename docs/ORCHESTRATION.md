# Settle - Orchestration (manager session only)

Setup: a Hermes session on Sonnet 5.5, reasoning effort high, acting as manager. All code is written by subagents via `delegate_task`, which on this machine run GLM (pinned in `~/.hermes/config.yaml` under `delegation.model`). The manager plans, briefs, verifies, integrates and commits. It writes code itself only for small fixes (a few lines) or when a card failed twice.

## Session start checklist
1. Read `AGENTS.md`, `docs/PROGRESS.md`, then the cards you're about to run in `docs/TASKS.md`.
2. `git status` and `git log --oneline -15` (once the repo exists) to confirm state matches PROGRESS. Code wins over the log if they disagree; fix the log.
3. Run the global gate to know the baseline is green before delegating anything.
4. Check `.env` has values for the keys the next cards need, without printing them:
   `bun -e "for (const k of ['TELEGRAM_BOT_TOKEN','MODEL_API_KEY','SUPABASE_URL','SUPABASE_SECRET_KEY']) console.log(k, process.env[k] ? 'set' : 'MISSING')"`

## Briefing a subagent
Subagents know nothing about this conversation and cannot ask questions. Every brief contains:
- **Goal**: the card ID and one-paragraph outcome.
- **Read first**: `AGENTS.md`, the card text (paste it in full), the ARCHITECTURE sections it cites, and the specific `docs/meta-api/*.md` files if it touches Meta APIs.
- **Owns**: exact file list. "Do not create or edit any other file. If you believe another file must change, stop and report which and why."
- **Interfaces**: paste the exact signatures/types of already-merged code it must import (copy from the real files, not from the plan, since the plan may have drifted).
- **Rules**: bun only; no git commands; no live Meta API calls, mock everything; don't read `.env`; no comments unless non-obvious; run the global gate before finishing.
- **Report format**: files changed, gate output (last lines of each command), decisions made, anything left undone, any deviation from the card.

Keep briefs tight. GLM does best with small, concrete cards: one module plus its tests. If a card feels big, split it before delegating (T06 is already split this way).

## Parallelism
- Run a parallel group (P1, P2...) as one `delegate_task` call with several tasks, only when owned files are disjoint.
- Files several cards want to touch (`lib/telegram/handlers.ts`, `lib/telegram/bot.ts`, `package.json`): only one card at a time edits them, or the manager applies those edits after the cards return.
- Dependency installs: the manager installs packages before releasing a group, so subagents don't race on `package.json`/`bun.lock`.

## Verifying returned work (never trust the self-report)
1. `git status` / `git diff --stat`: only the owned files changed.
2. Run the full gate yourself.
3. Read the diff. Check against the card: contract signatures, strict-schema rules, no secrets, no live calls in tests, no stray comments, user-facing copy has no em dashes.
4. If it fails: send one focused fix brief to a fresh subagent with the failing output, or fix directly if it's a few lines. Same bug failing 3 times total: stop and tell the user.
5. Commit locally: `git add <owned files>` then a plain message like `feat: telegram webhook with secret check and dedupe`. One commit per card. Never push.
6. Append to `docs/PROGRESS.md`: card, commit hash, gate result, decisions, follow-ups.

## Live checks (manager only, costs real credits)
- Only via `bun run eval -- <suite> --live` or the poll-mode bot. Note the printed cost in PROGRESS.
- Day exits in TASKS.md define which live checks to run. Expected total for the build: under $40.

## Things that need the user
- Anything in T00-H (accounts, keys, fixtures).
- Deploy, `setWebhook` to production, pushing to GitHub (T16).
- Product calls not settled in PRD/ARCHITECTURE (ask, don't guess).
- 3 failed attempts on one bug.
Send a Telegram heads-up before anything external-facing, per the user's standing rules.

## Context hygiene
- One session per day/phase. End each session by updating `docs/PROGRESS.md` with exact next steps, so the next session starts from that file instead of chat history.
- Don't paste whole files into your own context when a `git diff --stat` and targeted reads do.
- Useful Hermes skills to load when relevant: `test-driven-development`, `systematic-debugging`, `requesting-code-review` (run before the deploy card).
