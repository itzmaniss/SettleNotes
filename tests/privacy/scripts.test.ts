import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeDb } from "./fake-supabase";
import {
  BASE_OBJECTS,
  NAME_A,
  TELEGRAM_A,
  USER_A,
  baseTables,
} from "./fixtures";
import { parseDeleteArgs, runDelete } from "../../scripts/delete-user";
import {
  parseExportArgs,
  runExport,
  validateOutPath,
  writeExportFile,
} from "../../scripts/export-user";
import type { StorageApi } from "../../lib/privacy/storage";

const REPO_ROOT = "/tmp/fake-repo";

function storageOf(fakeDb: ReturnType<typeof makeFakeDb>): StorageApi {
  return (fakeDb.client as unknown as { storage: StorageApi }).storage;
}

function recorder() {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
}

function assertCleanOutput(lines: string[]): void {
  const text = lines.join("\n");
  expect(text).not.toContain(NAME_A);
  expect(text).not.toContain(String(TELEGRAM_A));
  expect(text).not.toContain(USER_A);
  expect(text).not.toContain("Secretname");
  expect(text).not.toMatch(/[\u2013\u2014]/);
}

describe("parseDeleteArgs", () => {
  test("accepts --telegram-id with optional --yes and --force", () => {
    expect(parseDeleteArgs(["--telegram-id", "5500112233"])).toEqual({
      ok: true,
      telegramId: 5500112233,
      yes: false,
      force: false,
    });
    expect(parseDeleteArgs(["--telegram-id", "5500112233", "--yes", "--force"])).toEqual({
      ok: true,
      telegramId: 5500112233,
      yes: true,
      force: true,
    });
  });

  test("refuses a missing, non numeric, zero, negative or fractional id", () => {
    expect(parseDeleteArgs([]).ok).toBe(false);
    expect(parseDeleteArgs(["--yes"]).ok).toBe(false);
    expect(parseDeleteArgs(["--telegram-id", "abc"]).ok).toBe(false);
    expect(parseDeleteArgs(["--telegram-id", "0"]).ok).toBe(false);
    expect(parseDeleteArgs(["--telegram-id", "-5"]).ok).toBe(false);
    expect(parseDeleteArgs(["--telegram-id", "1.5"]).ok).toBe(false);
  });

  test("refuses unknown arguments with the usage line", () => {
    const parsed = parseDeleteArgs(["--telegram-id", "5", "--bots"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.usage).toMatch(/Usage: bun run scripts\/delete-user\.ts/);
  });
});

describe("parseExportArgs", () => {
  test("accepts --telegram-id and --out", () => {
    expect(parseExportArgs(["--telegram-id", "5500112233", "--out", "/tmp/x.json"])).toEqual({
      ok: true,
      telegramId: 5500112233,
      out: "/tmp/x.json",
    });
  });

  test("refuses a missing id, a bad id, a missing or empty --out, and junk", () => {
    expect(parseExportArgs([]).ok).toBe(false);
    expect(parseExportArgs(["--out", "/tmp/x.json"]).ok).toBe(false);
    expect(parseExportArgs(["--telegram-id", "abc", "--out", "/tmp/x.json"]).ok).toBe(false);
    expect(parseExportArgs(["--telegram-id", "5"]).ok).toBe(false);
    expect(parseExportArgs(["--telegram-id", "5", "--out", ""]).ok).toBe(false);
    const parsed = parseExportArgs(["--telegram-id", "5", "--out", "/tmp/x.json", "--yes"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.usage).toMatch(/Usage: bun run scripts\/export-user\.ts/);
  });
});

describe("delete-user run", () => {
  test("dry run prints the short id, per table counts, files, events and blockers, and writes nothing", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const out = recorder();
    const code = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: out.log, error: out.error },
      { telegramId: TELEGRAM_A, yes: false, force: false },
    );
    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("user 11111111");
    expect(text).toContain("uploads 2");
    expect(text).toContain("tasks 2");
    expect(text).toContain("task_events 2");
    expect(text).toContain("starters 1");
    expect(text).toContain("weak_spots 1");
    expect(text).toContain("subscriptions 1");
    expect(text).toContain("usage_events 1");
    expect(text).toContain("pending_actions 1");
    expect(text).toContain("login_tokens 1");
    expect(text).toContain("ai_calls 2");
    expect(text).toContain("stored files to remove: 3");
    expect(text).toContain("billing events to scrub: 3");
    expect(text).toContain("active subscription (stripe)");
    expect(text).toContain("Dry run: nothing has been changed. Run again with --yes");
    assertCleanOutput(out.lines);
    const mutating = fake.ops.filter(
      (op) =>
        op.kind === "update" || op.kind === "delete" || op.kind === "insert" || op.kind === "storage.remove",
    );
    expect(mutating).toEqual([]);

    // Print a copy for the operator documentation.
    console.log(`[sample dry run for delete-user]\n${text}`);
  });

  test("--yes erases and prints the verification and the follow up reminders", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const out = recorder();
    const code = await runDelete(
      {
        client: fake.client,
        storage: storageOf(fake),
        bucket: "uploads",
        ...out,
      },
      { telegramId: TELEGRAM_A, yes: true, force: false },
    );
    expect(code).toBe(1); // blocked by the active subscription
    expect(out.lines.join("\n")).toContain("blocked until these are cancelled or expired");
    assertCleanOutput(out.lines);
  });

  test("an erased run reports success, reminders, and never personal data", async () => {
    const tables = baseTables();
    (tables.subscriptions ?? []).forEach((row) => {
      if (row.user_id === USER_A) row.current_period_end = "2026-01-01T00:00:00.000Z";
    });
    const fake = makeFakeDb(tables, { objects: BASE_OBJECTS });
    const out = recorder();
    const code = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: out.log, error: out.error },
      { telegramId: TELEGRAM_A, yes: true, force: false },
    );
    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("Erasure complete and verified for user 11111111.");
    expect(text).toContain("verification: every owned table now counts zero and the storage prefix is empty.");
    expect(text).toContain("Reply to the student by email");
    expect(text).toContain("your own request log");
    assertCleanOutput(out.lines);
    expect((fake.data.users ?? []).length).toBe(1);
    expect(fake.storageObjects().every((o) => o.startsWith(USER_A) === false)).toBe(true);
  });

  test("--force prints a loud charge warning when blockers exist", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const out = recorder();
    const code = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: out.log, error: out.error },
      { telegramId: TELEGRAM_A, yes: true, force: true },
    );
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toContain(
      "WARNING: --force is ignoring active subscriptions. The student may still be charged",
    );
  });

  test("an unknown Telegram id exits 0 with a nothing to delete line", async () => {
    const fake = makeFakeDb(baseTables());
    const out = recorder();
    const code = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: out.log, error: out.error },
      { telegramId: 42, yes: false, force: false },
    );
    expect(code).toBe(0);
    expect(out.lines).toEqual(["No Settle account exists for this Telegram id. Nothing to delete."]);
  });
});

describe("export-user run", () => {
  test("writes the file through the injected writer and prints counts and the path only", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const out = recorder();
    const written: Array<{ path: string; json: string }> = [];
    const code = await runExport(
      {
        client: fake.client,
        bucket: "uploads",
        repoRoot: REPO_ROOT,
        exists: () => false,
        writeFile: (path, json) => written.push({ path, json }),
        log: out.log,
        error: out.error,
      },
      { telegramId: TELEGRAM_A, out: "/tmp/private/export.json" },
    );
    expect(code).toBe(0);
    expect(written.length).toBe(1);
    expect(written[0]!.path).toBe("/tmp/private/export.json");
    const text = out.lines.join("\n");
    expect(text).toContain("Export written to /tmp/private/export.json with file mode 0600.");
    expect(text).toContain("uploads 2");
    expect(text).toContain("stored files 3");
    expect(text).toContain("The file holds personal data");
    assertCleanOutput(out.lines);
    const mutating = fake.ops.filter(
      (op) =>
        op.kind === "update" || op.kind === "delete" || op.kind === "insert" || op.kind === "storage.remove",
    );
    expect(mutating).toEqual([]);
  });

  test("a refused path prints the reason and never touches the database", async () => {
    const fake = makeFakeDb(baseTables());
    const out = recorder();
    const code = await runExport(
      {
        client: fake.client,
        bucket: "uploads",
        repoRoot: REPO_ROOT,
        exists: () => false,
        log: out.log,
        error: out.error,
      },
      { telegramId: TELEGRAM_A, out: `${REPO_ROOT}/docs/export.json` },
    );
    expect(code).toBe(1);
    expect(out.lines.join("\n")).toContain("docs/ is inside the repository");
    expect(fake.ops.length).toBe(0);
  });

  test("an unknown Telegram id exits 0 with a nothing to export line", async () => {
    const fake = makeFakeDb(baseTables());
    const out = recorder();
    const code = await runExport(
      {
        client: fake.client,
        bucket: "uploads",
        repoRoot: REPO_ROOT,
        exists: () => false,
        log: out.log,
        error: out.error,
      },
      { telegramId: 42, out: "/tmp/private/export.json" },
    );
    expect(code).toBe(0);
    expect(out.lines).toEqual(["No Settle account exists for this Telegram id. Nothing to export."]);
  });
});

describe("validateOutPath", () => {
  test("refuses an existing file", () => {
    const verdict = validateOutPath("/tmp/elsewhere/export.json", REPO_ROOT, () => true);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("already exists");
  });

  test("refuses repo internal paths and names docs, tests and public specifically", () => {
    for (const dir of ["docs", "tests", "public"]) {
      const verdict = validateOutPath(`${REPO_ROOT}/${dir}/export.json`, REPO_ROOT, () => false);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(`${dir}/ is inside the repository`);
    }
    const other = validateOutPath(`${REPO_ROOT}/scratch/export.json`, REPO_ROOT, () => false);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toContain("inside the repository directory");
  });

  test("allows a path outside the repository", () => {
    const verdict = validateOutPath("/var/private/export.json", REPO_ROOT, () => false);
    expect(verdict).toEqual({ ok: true, resolved: "/var/private/export.json" });
  });
});

describe("writeExportFile", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempPath(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "settle-export-test-"));
    dirs.push(dir);
    return join(dir, name);
  }

  test("creates the file with mode 0600", () => {
    const path = tempPath("export.json");
    writeExportFile(path, "{}");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

  test("refuses to overwrite an existing file", () => {
    const path = tempPath("export.json");
    writeExportFile(path, "{}");
    expect(() => writeExportFile(path, "{}")).toThrow();
  });

  test("the file never ends up group or world readable", () => {
    const path = tempPath("export.json");
    writeExportFile(path, "{}");
    // The creation mode 0600 is enforced outright (chmod after write), so it
    // holds whatever the process umask is.
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

// The read only guarantee for the export path, enforced on the source: call
// syntax for any PostgREST write or storage remove must not appear.
describe("read only source scan for the export path", () => {
  const sources = [
    readFileSync(new URL("../../scripts/export-user.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../lib/privacy/export.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../lib/privacy/query.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../../lib/privacy/subject.ts", import.meta.url), "utf8"),
  ];

  test("no insert, update, delete, upsert, rpc or storage remove call anywhere", () => {
    for (const source of sources) {
      for (const method of ["insert", "update", "delete", "upsert", "rpc", "remove"]) {
        expect(source).not.toContain(`.${method}(`);
      }
    }
  });

  test("the export script never imports the erase or storage removal code", () => {
    const script = sources[0]!;
    expect(script).not.toContain("removeStoredFiles");
    expect(script).not.toContain("eraseUser");
    const imports = [...script.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const target of imports) {
      expect([
        "node:fs",
        "node:path",
        "@supabase/supabase-js",
        "../lib/db/client",
        "../lib/env",
        "../lib/privacy/subject",
        "../lib/privacy/export",
      ]).toContain(target);
    }
  });
});
