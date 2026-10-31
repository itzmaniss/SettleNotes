import { describe, expect, test } from "bun:test";
import { makeFakeDb, type RecordedOp } from "./fake-supabase";
import { FUTURE, USER_A, baseTables } from "./fixtures";
import { EraseStepError, eraseUser } from "../../lib/privacy/erase";
import type { StorageApi } from "../../lib/privacy/storage";

function storageOf(fakeDb: ReturnType<typeof makeFakeDb>): StorageApi {
  return (fakeDb.client as unknown as { storage: StorageApi }).storage;
}

const NOW = () => new Date("2026-10-31T00:00:00.000Z");

function opKindAt(fakeOps: RecordedOp[], predicate: (op: RecordedOp) => boolean): number {
  return fakeOps.findIndex(predicate);
}

function manyPaths(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${USER_A}/bulk${Math.floor(i / 100)}/file-${i}.png`);
}

describe("eraseUser", () => {
  test("runs in order: blockers, scrub, storage, delete user, verify", async () => {
    const fake = makeFakeDb(baseTables(), { objects: [`${USER_A}/up/original.jpg`] });
    // Unblock: the fixture subscription is active; force skips it.
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW },
      { userId: USER_A, dryRun: false, force: true },
    );
    expect(report.status).toBe("erased");
    const ops = fake.ops;
    const blockersIdx = opKindAt(ops, (op) => op.kind === "select" && op.table === "subscriptions");
    const scrubIdx = opKindAt(ops, (op) => op.kind === "update" && op.table === "billing_events");
    const storageIdx = opKindAt(ops, (op) => op.kind === "storage.remove");
    const deleteIdx = opKindAt(ops, (op) => op.kind === "delete" && op.table === "users");
    const verifyIdx = ops.findIndex(
      (op, i) => i > deleteIdx && op.kind === "select" && op.head === true && op.table === "uploads",
    );
    expect(blockersIdx).toBeGreaterThanOrEqual(0);
    expect(scrubIdx).toBeGreaterThan(blockersIdx);
    expect(storageIdx).toBeGreaterThan(scrubIdx);
    expect(deleteIdx).toBeGreaterThan(storageIdx);
    expect(verifyIdx).toBeGreaterThan(deleteIdx);
    expect(report.completedSteps).toEqual(["blockers", "scrub", "storage", "delete_user", "verify"]);
  });

  test("a dry run writes nothing at all", async () => {
    const fake = makeFakeDb(baseTables(), { objects: [`${USER_A}/up/original.jpg`] });
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW },
      { userId: USER_A, dryRun: true },
    );
    expect(report.status).toBe("dry_run");
    expect(report.before).toBeDefined();
    expect(report.filesBefore).toBe(1);
    expect(report.eventsMatched).toBe(3);
    const mutating = fake.ops.filter(
      (op) =>
        op.kind === "update" || op.kind === "delete" || op.kind === "insert" || op.kind === "storage.remove",
    );
    expect(mutating).toEqual([]);
    // And the world is untouched.
    expect((fake.data.users ?? []).length).toBe(2);
    expect(fake.storageObjects().length).toBe(1);
  });

  test("blocks on an active subscription and writes nothing, even with dryRun false", async () => {
    const fake = makeFakeDb(baseTables(), { objects: [`${USER_A}/up/original.jpg`] });
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", now: NOW },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("blocked");
    expect(report.blockers.length).toBe(1);
    expect(report.blockers[0]!.kind).toBe("stripe");
    const mutating = fake.ops.filter(
      (op) =>
        op.kind === "update" || op.kind === "delete" || op.kind === "insert" || op.kind === "storage.remove",
    );
    expect(mutating).toEqual([]);
  });

  test("force ignores the blockers and completes", async () => {
    const fake = makeFakeDb(baseTables(), { objects: [`${USER_A}/up/original.jpg`] });
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", now: NOW },
      { userId: USER_A, dryRun: false, force: true },
    );
    expect(report.status).toBe("erased");
    expect(report.blockers.length).toBe(1);
    expect((fake.data.users ?? []).length).toBe(1);
    expect(fake.storageObjects()).toEqual([]);
  });

  test("a storage failure halfway keeps earlier results and a rerun finishes", async () => {
    const objects = manyPaths(250);
    const tables = baseTables();
    // No blockers this time: expire the subscription.
    (tables.subscriptions ?? []).forEach((row) => {
      if (row.user_id === USER_A) row.current_period_end = "2026-01-01T00:00:00.000Z";
    });
    const fake = makeFakeDb(tables, { objects, removeFailAtCall: 2 });

    let firstError: EraseStepError | null = null;
    try {
      await eraseUser(
        { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW },
        { userId: USER_A, dryRun: false },
      );
    } catch (err) {
      firstError = err as EraseStepError;
    }
    expect(firstError).toBeInstanceOf(EraseStepError);
    expect(firstError!.step).toBe("storage");
    expect(firstError!.report.completedSteps).toEqual(["blockers", "scrub"]);
    expect(firstError!.report.filesRemoved).toBe(100);
    expect(firstError!.report.eventsScrubbed).toBe(3);
    // Rows are still there: the failure came before the delete.
    expect((fake.data.users ?? []).length).toBe(2);
    expect(fake.storageObjects().length).toBe(150);

    const second = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW },
      { userId: USER_A, dryRun: false },
    );
    expect(second.status).toBe("erased");
    expect(second.filesBefore).toBe(150);
    expect(second.filesRemoved).toBe(150);
    expect(fake.storageObjects()).toEqual([]);
    expect((fake.data.users ?? []).length).toBe(1);
  });

  test("a second run on an already erased account reports nothing to delete, without error", async () => {
    const tables = baseTables();
    (tables.subscriptions ?? []).forEach((row) => {
      if (row.user_id === USER_A) row.current_period_end = "2026-01-01T00:00:00.000Z";
    });
    const fake = makeFakeDb(tables, { objects: [`${USER_A}/up/original.jpg`] });
    const deps = { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW };
    const first = await eraseUser(deps, { userId: USER_A, dryRun: false });
    expect(first.status).toBe("erased");
    const marker = fake.ops.length;

    const second = await eraseUser(deps, { userId: USER_A, dryRun: false });
    expect(second.status).toBe("nothing_to_delete");
    const mutating = fake.ops
      .slice(marker)
      .filter((op) => op.kind === "update" || op.kind === "delete" || op.kind === "insert" || op.kind === "storage.remove");
    expect(mutating).toEqual([]);
  });

  test("verification catches rows that survived the cascade", async () => {
    const tables = baseTables();
    (tables.subscriptions ?? []).forEach((row) => {
      if (row.user_id === USER_A) row.current_period_end = "2026-01-01T00:00:00.000Z";
    });
    const fake = makeFakeDb(tables, { objects: [`${USER_A}/up/original.jpg`], noCascade: true });
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", now: NOW },
      { userId: USER_A, dryRun: false },
    );
    expect(report.status).toBe("incomplete");
    expect(report.message).toMatch(/left over/);
    expect(report.after?.uploads).toBe(2);
    expect(report.filesAfter).toBe(0);
  });

  test("a database delete failure reports the step and keeps the storage results", async () => {
    const tables = baseTables();
    (tables.subscriptions ?? []).forEach((row) => {
      if (row.user_id === USER_A) row.current_period_end = "2026-01-01T00:00:00.000Z";
    });
    const fake = makeFakeDb(tables, { objects: [`${USER_A}/up/original.jpg`] });
    // Sabotage the users table so the delete matches nothing and errors.
    fake.data.users = [];
    // But then nothing_to_delete would trigger, so put the row back without cascades reachable:
    // instead, simulate an erroring delete via a proxy client.
    const errClient = new Proxy(fake.client, {
      get(target, prop) {
        if (prop === "from") {
          return (table: string) => {
            const originalFrom = target as unknown as { from: (t: string) => unknown };
            const inner = originalFrom.from(table) as Record<string, unknown>;
            if (table === "users") {
              // Reads pass through; only the users delete always answers an
              // error.
              return new Proxy(inner, {
                get(t, p, receiver) {
                  if (p === "delete") {
                    return () => {
                      const u = {
                        eq: () => u,
                        then: (res?: (v: unknown) => unknown) =>
                          Promise.resolve({ data: null, error: { message: "delete refused" }, count: 0 }).then(res),
                      };
                      return u;
                    };
                  }
                  return Reflect.get(t, p, receiver);
                },
              });
            }
            return inner;
          };
        }
        return Reflect.get(target as object, prop);
      },
    });
    try {
      await eraseUser(
        { client: errClient, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW },
        { userId: USER_A, dryRun: false },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EraseStepError);
      expect((err as EraseStepError).step).toBe("delete_user");
      expect((err as EraseStepError).report.completedSteps).toEqual(["blockers", "scrub", "storage"]);
      expect((err as EraseStepError).report.filesRemoved).toBe(1);
      expect((err as EraseStepError).report.eventsScrubbed).toBe(3);
    }
    // Storage really went through and the rerun will only see the rows.
    expect(fake.storageObjects()).toEqual([]);
  });

  test("the fixture world still has an active subscription in the future", () => {
    expect(FUTURE > "2026-10-31").toBe(true);
  });
});
