# Settle - Product Requirements

## Problem

Students don't fail because they can't do the work; they lose track of it. Deadlines live in group chats, briefs run 30 pages, slides pile up, and mistakes in practice papers go unnoticed until the exam.

## Users

- Primary: Singapore secondary/JC/university students who live in Telegram.
- Pilot: the builder's own math and computing tutoring students.

## Core loop

Capture anything -> one prioritised task list -> each task has its first step done -> mistakes become weak spots -> weak spots become review tasks.

## Features

### F1. Capture (Telegram)
Inputs accepted from a private chat with the bot:
- Plain text and forwarded messages (often Singlish).
- Photos: group chat screenshots, slide photos, handwritten math working.
- Documents: PDF (assignment briefs, lecture slides). Max 20 MB (Telegram bot download limit).
- Voice notes (OGG/Opus).

Behaviour:
- Bot shows a chat action ("typing" / "upload_photo") within 1s and acks every input.
- Every input is understood in one call that sees the student's current open tasks, so it can create, update (deadline/title), complete, or ignore.
- Reply summarises what changed in plain language, e.g. "Moved CS2040 Lab 4 to Fri 7 Nov (was Wed 5 Nov). Added 2 new tasks." with an "Open dashboard" button.
- Duplicate detection: an input that refers to an existing task updates it, never duplicates it.

Acceptance:
- "prof say extend to nxt fri liao" with one matching open task updates that task's `due_at`, logs a `task_events` row with the quoted evidence, creates no new task.
- A screenshot of a 20+ message group chat with 3 distinct deadlines creates 3 tasks with correct dates.
- Ambiguous references (two candidate tasks) produce a clarifying question with inline buttons rather than a guess (stretch, see T15).

### F2. Task list and priority
- Tasks: title, course (optional), kind (`assignment | test | reading | math_practice | review | other`), due_at (nullable), status, priority score.
- Priority is computed deterministically in code from due date proximity, kind weight and estimated effort (model gives effort estimate only). Recomputed on read.
- Commands: `/tasks` (top 5 in chat), `/done <n>`, `/dashboard` (magic link), `/help`.

### F3. First step done (starters)
Generated automatically after a task is created from a source document/photo.
- **Checklist** (assignment brief PDF): deliverables, submission rules (format, platform, naming, word limit), rubric requirements, each with a page reference. Items are tickable on the dashboard.
- **Flashcards + practice questions** (slides PDF / test task): 10-20 cards, 3-5 practice questions with worked answers, each tagged with slide/page reference.
- **Math diagnosis** (photo of working, optional caption with the expected answer):
  - Transcribes the working into numbered steps.
  - Identifies the first incorrect step index, what's wrong, and the underlying misconception (topic from a fixed taxonomy plus free-text detail).
  - If the working is correct, says so.
  - 2-3 targeted practice questions on that misconception, with answers.
  - Bot replies with the original photo annotated: a box around the wrong step (perception grounding).

Acceptance: on the 5 fixture math photos, the flagged step matches the human-labelled wrong step in at least 4.

### F4. Weak-spot loop
- Each diagnosis with an error upserts `weak_spots(user, topic)`: occurrences++, last_seen_at.
- Creates a `review` task with the targeted practice as its starter. Due date by spacing: 1st occurrence +3 days, 2nd +1 day, 3rd+ +1 day and flagged "recurring".
- Dashboard weak-spots page: topics, counts, last seen, next review.

### F5. Dashboard (web)
- Login via `/dashboard` magic link (single use, 15 min). Session cookie 7 days.
- Home: tasks grouped Overdue / Today / This week / Later, priority order, calm minimal design ("relief, not clutter").
- Task card expands to its starter: tickable checklist, flip flashcards, diagnosis with annotated image and step list.
- Task history: deadline changes with the quoted chat evidence (shows the Singlish parsing working).
- Weak spots page.

### F6. Voice notes
- Transcribe with Muse Voice Transcribe (English bias, course codes as keywords), then run the transcript through F1.

## Non-goals (hackathon)
Group chat membership (bot reads only what's forwarded to it in DMs), calendar sync, multi-language UI, mobile app, payments, teacher accounts.

## Demo script (target 2-3 min, check hackathon limit)
1. Pain (15s): a chaotic 30-message Singlish group chat, a 30-page brief, a page of math working.
2. Capture (40s): forward the screenshot to Settle; reply lists 3 tasks. Send "prof say extend to nxt fri liao"; reply shows the deadline moved, no duplicate.
3. First step done (50s): send the brief PDF -> checklist. Send slides -> flashcards. Send math photo -> annotated photo with the wrong step boxed, misconception named, 3 practice questions.
4. Loop (25s): dashboard shows the new review task from the weak spot, history shows the evidence quote.
5. Meta tooling callout (15s): Muse Spark for multimodal understanding, structured output, reasoning effort per task, perception grounding; Muse Voice Transcribe for Singlish voice notes.
6. Close (10s): "Give students back the energy they spend remembering what to do."

## Assets the user must provide (agents cannot fabricate these)
- 3+ real group chat screenshots with Singlish deadline chatter (can be staged).
- 2 assignment brief PDFs, 2 lecture slide PDFs.
- 5 photos of handwritten math working with a known wrong step (label which step).
- 2 voice notes.
Place them in `tests/fixtures/real/` (gitignored if they contain personal data) with a `labels.json`.
