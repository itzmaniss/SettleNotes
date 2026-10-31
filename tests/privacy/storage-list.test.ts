import { describe, expect, test } from "bun:test";
import { makeFakeDb, type RecordedOp } from "./fake-supabase";
import { USER_A, USER_B } from "./fixtures";
import {
  REMOVE_BATCH_SIZE,
  batchPaths,
  listStoredFiles,
  removeStoredFiles,
  type StorageApi,
} from "../../lib/privacy/storage";

function storageOf(fakeDb: ReturnType<typeof makeFakeDb>): StorageApi {
  return (fakeDb.client as unknown as { storage: StorageApi }).storage;
}

describe("listStoredFiles", () => {
  test("walks folders recursively and returns full paths under the user prefix", async () => {
    const fake = makeFakeDb({}, { objects: [
      `${USER_A}/up1/original.jpg`,
      `${USER_A}/up1/annotated.jpg`,
      `${USER_A}/up2/original.pdf`,
      `${USER_B}/up1/original.jpg`,
      "stray.jpg",
    ] });
    const files = await listStoredFiles(storageOf(fake), "uploads", USER_A);
    expect(files).toEqual([
      `${USER_A}/up1/annotated.jpg`,
      `${USER_A}/up1/original.jpg`,
      `${USER_A}/up2/original.pdf`,
    ]);
  });

  test("other users' prefixes are never listed", async () => {
    const fake = makeFakeDb({}, { objects: [`${USER_B}/up1/original.jpg`, `${USER_B}/nested/deep/file.png`] });
    const files = await listStoredFiles(storageOf(fake), "uploads", USER_A);
    expect(files).toEqual([]);
    const listed = fake.ops
      .filter((op): op is Extract<RecordedOp, { kind: "storage.list" }> => op.kind === "storage.list")
      .map((op) => op.path);
    expect(listed.every((path) => path.startsWith(`${USER_A}/`))).toBe(true);
  });

  test("pagination ends: a short page terminates each level", async () => {
    const objects = Array.from({ length: 5 }, (_, i) => `${USER_A}/bulk/file-${i}.png`);
    const fake = makeFakeDb({}, { objects });
    const files = await listStoredFiles(storageOf(fake), "uploads", USER_A, { pageSize: 2 });
    expect(files.length).toBe(5);
    const lists = fake.ops.filter(
      (op): op is Extract<RecordedOp, { kind: "storage.list" }> => op.kind === "storage.list",
    );
    // 5 files at a page size of 2 means offsets 0, 2, 4, then a short page.
    const filePages = lists.filter((op) => op.path === `${USER_A}/bulk/`);
    expect(filePages.map((op) => op.offset ?? 0)).toEqual([0, 2, 4]);
    // And the caller always passed the page size it chose.
    expect(lists.every((op) => op.limit === 2)).toBe(true);
  });

  test("pagination across several folders recurses until every level ends", async () => {
    const objects = [
      ...Array.from({ length: 3 }, (_, i) => `${USER_A}/one/file-${i}.png`),
      ...Array.from({ length: 4 }, (_, i) => `${USER_A}/two/file-${i}.png`),
    ];
    const fake = makeFakeDb({}, { objects });
    const files = await listStoredFiles(storageOf(fake), "uploads", USER_A, { pageSize: 2 });
    expect(files.length).toBe(7);
    expect(files.every((f) => f.startsWith(`${USER_A}/`))).toBe(true);
  });

  test("empty prefix lists as an empty array", async () => {
    const fake = makeFakeDb({}, { objects: [`${USER_B}/up1/original.jpg`] });
    expect(await listStoredFiles(storageOf(fake), "uploads", USER_A)).toEqual([]);
  });

  test("a listing that never ends aborts with the runaway guard error", async () => {
    // Folders that never run out: the walk recurses forever without ever
    // collecting a file, so the page guard must fire.
    const fake = makeFakeDb({}, { infiniteFolders: true });
    expect(
      listStoredFiles(storageOf(fake), "uploads", USER_A),
    ).rejects.toThrow(/did not end after/);
  });

  test("a file listing that never ends aborts on the file count guard", async () => {
    const fake = makeFakeDb({}, { objects: [`${USER_A}/up1/original.jpg`], infiniteList: true });
    expect(
      listStoredFiles(storageOf(fake), "uploads", USER_A),
    ).rejects.toThrow(/more than 50000 storage files/);
  });

  test("a list error from the backend propagates", async () => {
    const broken: StorageApi = {
      from: () => ({
        list: async () => ({ data: null, error: { message: "boom" } }),
        remove: async () => ({ data: null, error: null }),
      }),
    };
    expect(listStoredFiles(broken, "uploads", USER_A)).rejects.toThrow(/boom/);
  });
});

describe("removeStoredFiles", () => {
  test("removes in batches of 100", async () => {
    const paths = Array.from({ length: 250 }, (_, i) => `${USER_A}/bulk/file-${i}`);
    const fake = makeFakeDb({}, { objects: paths });
    const removed = await removeStoredFiles(storageOf(fake), "uploads", paths);
    expect(removed.length).toBe(250);
    expect(fake.removedBatches.map((batch) => batch.length)).toEqual([
      REMOVE_BATCH_SIZE,
      REMOVE_BATCH_SIZE,
      50,
    ]);
    expect(fake.storageObjects()).toEqual([]);
  });

  test("a failed batch keeps the report of what already went", async () => {
    const paths = Array.from({ length: 250 }, (_, i) => `${USER_A}/bulk/file-${i}`);
    const fake = makeFakeDb({}, { objects: paths, removeFailAtCall: 2 });
    try {
      await removeStoredFiles(storageOf(fake), "uploads", paths);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("StorageRemoveError");
      expect((err as Error).message).toMatch(/failed after 100 of 250/);
    }
    expect(fake.storageObjects().length).toBe(150);
  });

  test("batchPaths is a pure slicing helper", () => {
    expect(batchPaths([], 100)).toEqual([]);
    expect(batchPaths(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(batchPaths(["a"], 100)).toEqual([["a"]]);
  });
});
