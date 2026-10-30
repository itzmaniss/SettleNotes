# Eval fixtures

The eval harness (`bun run eval -- <suite>`) reads JSON fixtures from two places:

- `tests/fixtures/<suite>/*.json`: checked-in fixtures (synthetic, no personal data).
- `tests/fixtures/real/<suite>/*.json`: optional, gitignored, for real files the user provides.

Suites: `understand`, `math`, `checklist`, `flashcards`. Files load in filename order; `labels.json` is never treated as a fixture.

## Understand fixtures

Each file describes one input and what the model should do with it:

```json
{
  "id": "extend-nxt-fri",
  "description": "optional human note",
  "now": "2026-10-28T09:00:00+08:00",
  "openTasks": [
    {
      "id": "task-1",
      "title": "CS2030 Lab 4",
      "course": "CS2030",
      "kind": "assignment",
      "due_at": "2026-10-30T15:59:00.000Z"
    }
  ],
  "text": "prof say extend lab 4 to nxt fri liao",
  "expected": {
    "actions": [
      { "type": "update", "task_ref": "T1", "due_local": "2026-11-06T23:59" }
    ],
    "needs_clarification": false
  }
}
```

- `now` sets the clock. Relative words (tmr, nxt fri, ytd) resolve against it.
- `openTasks` are the tasks the bot already holds. In `expected.actions`, they are referenced as `T1`, `T2`, ... in the order they appear in `openTasks`.
- `text`, `image`, `pdf` are the input; at least one should be set. `image` and `pdf` are file paths relative to the fixture file, e.g. `"image": "screenshots/chat1.jpg"`. They are read (as base64) only during a live run.
- `expected.actions` types are `create`, `update`, `complete`. A `none` on either side is ignored. Matching: `task_ref`, `course`, `kind`, `effort`, `due_local` must be exact; `title` matches as a case-insensitive substring in either direction.
- `needs_clarification: true` means the model must come back with a question (non-empty string); `false` means it must not.
- `description`, `text`, `image`, `pdf`, `course` and `due_at` are optional or nullable where it makes sense.

## Other suites (math, checklist, flashcards)

Any JSON object with a string `id`. The rest of the shape is free-form for now and will tighten when those suite runners arrive.

## Real files

Put real screenshots, PDFs, photos and their expected labels in `tests/fixtures/real/<suite>/`, with a `labels.json` alongside describing them. This directory is gitignored because real fixtures may carry personal data (chat names, student work, grades). Never commit them.

## Running

```sh
bun run eval -- understand            # dry run: no keys needed, no calls made
bun run eval -- understand --limit 3  # dry run, first 3 fixtures only
bun run eval -- understand --live     # real Meta API calls (manager only)
```

- The dry run lists what would be sent (text length, image/pdf attached or not) and the estimated cost. It works with no keys and no env.
- `--max-usd x` (default 2) stops a live run once its cumulative spend passes x USD.
- Live evals spend real credits. The manager runs them; everyone else uses the dry run.
