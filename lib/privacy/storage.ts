// Storage helpers for one user's prefix. Objects live under
// <userId>/<uploadId>/ in the private bucket (lib/media/storage.ts builds
// those paths), so listing the <userId>/ prefix covers every file the
// account owns. All deps are injected; nothing here imports env or the
// database client.

export type StorageFileEntry = { name: string; id: string | null };
export type StorageListResult = {
  data: StorageFileEntry[] | null;
  error: { message: string } | null;
};
export type StorageRemoveResult = { data: unknown; error: { message: string } | null };

export type StorageBucketApi = {
  list(path?: string, options?: { limit?: number; offset?: number }): Promise<StorageListResult>;
  remove(paths: string[]): Promise<StorageRemoveResult>;
};

export type StorageApi = { from(bucket: string): StorageBucketApi };

// Page size for list calls; small pages keep the offset pagination simple.
export const STORAGE_PAGE_SIZE = 200;
// A listing that never ends (a broken backend, a weird prefix) must abort
// instead of hanging the operator's terminal forever.
export const MAX_LIST_PAGES = 500;
export const MAX_STORAGE_FILES = 50_000;
export const REMOVE_BATCH_SIZE = 100;

// Recursively lists every object under <userId>/ and returns full paths.
// The storage list API answers folder placeholders as entries with a null id;
// the walk recurses into those and pages each level with limit and offset
// until a short page comes back. The page size is injectable so tests can
// exercise multi page levels without 200 files of fixtures.
export async function listStoredFiles(
  storage: StorageApi,
  bucket: string,
  userId: string,
  options: { pageSize?: number } = {},
): Promise<string[]> {
  const pageSize = options.pageSize ?? STORAGE_PAGE_SIZE;
  const files: string[] = [];
  let pages = 0;
  const walk = async (folder: string): Promise<void> => {
    let offset = 0;
    for (;;) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(
          `storage listing did not end after ${MAX_LIST_PAGES} pages; stopping to avoid a runaway loop`,
        );
      }
      const page = await storage.from(bucket).list(folder, { limit: pageSize, offset });
      if (page.error) throw new Error(`storage list failed for "${folder}": ${page.error.message}`);
      const entries = page.data ?? [];
      for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const path = `${folder}${entry.name}`;
        if (entry.id == null) {
          await walk(`${path}/`);
        } else {
          files.push(path);
          if (files.length > MAX_STORAGE_FILES) {
            throw new Error(`more than ${MAX_STORAGE_FILES} storage files for one user; stopping`);
          }
        }
      }
      if (entries.length < pageSize) return;
      offset += entries.length;
    }
  };
  await walk(`${userId}/`);
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function batchPaths(paths: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += size) out.push(paths.slice(i, i + size));
  return out;
}

export class StorageRemoveError extends Error {
  readonly removed: string[];

  constructor(removed: string[], message: string) {
    super(message);
    this.name = "StorageRemoveError";
    this.removed = removed;
  }
}

// Removes in batches and reports what is already gone even when a batch
// fails, so the caller can simply run again: the next listing will not see
// the removed files.
export async function removeStoredFiles(
  storage: StorageApi,
  bucket: string,
  paths: string[],
  batchSize = REMOVE_BATCH_SIZE,
): Promise<string[]> {
  const removed: string[] = [];
  for (const batch of batchPaths(paths, batchSize)) {
    const { error } = await storage.from(bucket).remove(batch);
    if (error) {
      throw new StorageRemoveError(
        removed,
        `storage remove failed after ${removed.length} of ${paths.length} files: ${error.message}`,
      );
    }
    removed.push(...batch);
  }
  return removed;
}
