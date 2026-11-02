// Operator tool: export one student's data for an access request. Read only:
// the database and storage are never changed. Writes one JSON file.
// Usage: bun run scripts/export-user.ts --telegram-id <id> --out <file.json>
//
// SAFETY: refuses to overwrite an existing file and refuses any path inside
// the repository directory, including docs/, tests/ and public/ (the export
// holds personal data and must never end up in git). The file is written with
// mode 0600. Output prints counts and the output path only, never contents.
// Not imported by app code. Runs under bun only.

import { chmodSync, closeSync, existsSync, openSync, writeSync } from "node:fs";
import { relative, resolve as resolvePath, isAbsolute, sep } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/db/client";
import { getEnv } from "../lib/env";
import { SubjectResolutionError, resolveSubject, shortId } from "../lib/privacy/subject";
import { buildExport } from "../lib/privacy/export";

export const EXPORT_USAGE =
  "Usage: bun run scripts/export-user.ts --telegram-id <id> --out <file.json>";

export type ParsedExportArgs =
  | { ok: true; telegramId: number; out: string }
  | { ok: false; usage: string };

// Pure arg parsing so a mistyped id or path can never reach the database.
export function parseExportArgs(argv: string[]): ParsedExportArgs {
  let telegramId: number | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--telegram-id") {
      telegramId = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--out") {
      out = argv[i + 1];
      i += 1;
    } else {
      return { ok: false, usage: EXPORT_USAGE };
    }
  }
  if (telegramId === undefined || !Number.isSafeInteger(telegramId) || telegramId <= 0) {
    return { ok: false, usage: EXPORT_USAGE };
  }
  if (out === undefined || out.trim().length === 0) {
    return { ok: false, usage: EXPORT_USAGE };
  }
  return { ok: true, telegramId, out };
}

export type OutPathVerdict = { ok: true; resolved: string } | { ok: false; reason: string };

// The export contains personal data, so it must land outside the repository:
// no overwriting, and nothing git could pick up.
export function validateOutPath(
  out: string,
  repoRoot: string,
  exists: (path: string) => boolean,
): OutPathVerdict {
  const resolved = resolvePath(out);
  if (exists(resolved)) {
    return {
      ok: false,
      reason: `${resolved} already exists. The script never overwrites; pick a file name that does not exist yet.`,
    };
  }
  const root = resolvePath(repoRoot);
  const rel = relative(root, resolved);
  const inside = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  if (!inside) return { ok: true, resolved };
  const top = rel.split(sep)[0] ?? "";
  if (top === "docs" || top === "tests" || top === "public") {
    return {
      ok: false,
      reason: `${top}/ is inside the repository. The export holds personal data and must never end up in git; write it outside the repository.`,
    };
  }
  return {
    ok: false,
    reason:
      "That path is inside the repository directory. The export holds personal data and must never end up in git; write it outside the repository.",
  };
}

export function writeExportFile(filePath: string, json: string): void {
  // "wx" refuses to create over an existing file (a second guard next to
  // validateOutPath) and 0600 keeps the file private from the moment it
  // exists.
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeSync(fd, json);
  } finally {
    closeSync(fd);
  }
  // openSync modes pass through the process umask; enforce 0600 outright.
  chmodSync(filePath, 0o600);
}

export type ExportDeps = {
  client: SupabaseClient;
  bucket: string;
  repoRoot: string;
  exists: (path: string) => boolean;
  writeFile?: (filePath: string, json: string) => void;
  log: (line: string) => void;
  error: (line: string) => void;
};

export async function runExport(
  deps: ExportDeps,
  args: { telegramId: number; out: string },
): Promise<number> {
  const verdict = validateOutPath(args.out, deps.repoRoot, deps.exists);
  if (!verdict.ok) {
    deps.error(verdict.reason);
    return 1;
  }

  let userId: string;
  try {
    userId = await resolveSubject(deps.client, { telegramId: args.telegramId });
  } catch (err) {
    if (err instanceof SubjectResolutionError) {
      if (err.code === "not_found") {
        deps.log("No Settle account exists for this Telegram id. Nothing to export.");
        return 0;
      }
      deps.error(err.message);
      return 1;
    }
    throw err;
  }

  const data = await buildExport(deps.client, userId, { bucket: deps.bucket });
  const json = JSON.stringify(data, null, 2);
  (deps.writeFile ?? writeExportFile)(verdict.resolved, json);
  deps.log(`Export written to ${verdict.resolved} with file mode 0600.`);
  deps.log(
    `user ${shortId(userId)}: ` +
      [
        `uploads ${data.uploads.length}`,
        `tasks ${data.tasks.length}`,
        `task_events ${data.task_events.length}`,
        `starters ${data.starters.length}`,
        `weak_spots ${data.weak_spots.length}`,
        `subscriptions ${data.subscriptions.length}`,
        `usage_events ${data.usage_events.length}`,
        `pending_actions ${data.pending_actions.length}`,
        `purchase_confirmations ${data.purchase_confirmations.length}`,
        `ai calls ${data.ai_calls_summary.count}`,
        `stored files ${data.files.length}`,
      ].join(", "),
  );
  deps.log("The file holds personal data. Send it to the student, then delete it securely.");
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseExportArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.usage);
    return 1;
  }
  const env = getEnv(); // fail fast with the normal env validation message
  const client = getSupabase();
  return runExport(
    {
      client,
      bucket: env.SUPABASE_STORAGE_BUCKET,
      repoRoot: resolvePath(import.meta.dir, ".."),
      exists: existsSync,
      log: console.log,
      error: console.error,
    },
    parsed,
  );
}

if (import.meta.main) {
  process.exit(await main());
}
