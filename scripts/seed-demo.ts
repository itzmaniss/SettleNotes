// Seed one allowlisted Telegram user with a lived-in demo dashboard.
// SAFE BY DEFAULT: without --yes this only prints what it WOULD write.
//
// Usage: bun run seed:demo -- --telegram-id <id> [--name <first name>] [--reset] [--yes]
//
// The data itself comes from ./seed-demo-data.ts (pure). This file owns all
// I/O: env, Supabase, Storage and the sharp-rendered math photo. It runs under
// bun only (the bunfig preload mocks "server-only" for imports) and is never
// imported by app code.

import sharp from "sharp";

import { getSupabase } from "../lib/db/client";
import { createQueries } from "../lib/db/queries";
import type { UserRow } from "../lib/db/types";
import { getEnv } from "../lib/env";
import { annotatedPath, originalPath, uploadBuffer } from "../lib/media/storage";
import {
  DEMO_UPLOAD_MARKER,
  buildDemoData,
  formatDryRunPlan,
  parseSeedArgs,
  type DemoData,
} from "./seed-demo-data";

const PAPER_COLOR = { r: 247, g: 243, b: 232 };
const INK_COLOR = "#3a3a3a";
const RULE_COLOR = "#b9c6d8";
const RING_COLOR = "#e5484d";

type SeedArgs = { apply: boolean; reset: boolean; telegramId: number; name: string | null };

// Handwriting is abstract ink strokes, never SVG <text>, so the rendering does
// not depend on installed fonts (same reasoning as lib/media/annotate.ts).
function inkSvg(width: number, height: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const y = 145 + i * 80;
    parts.push(
      `<line x1="60" y1="${y}" x2="${width - 60}" y2="${y}" stroke="${RULE_COLOR}" stroke-width="2"/>`
    );
  }
  // Working lines of varying length and height, one per diagnosis step row.
  const strokes: Array<[number, number, number]> = [
    [110, 130, 500],
    [120, 320, 540],
    [140, 540, 600],
    [110, 730, 560],
    [130, 910, 480],
    [120, 1090, 520],
    [150, 1270, 420],
    [130, 1440, 460],
    [110, 1620, 380],
  ];
  for (const [x1, y1, length] of strokes) {
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x1 + length}" y2="${y1}" stroke="${INK_COLOR}" stroke-width="4" stroke-linecap="round"/>`
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    parts.join("") +
    "</svg>"
  );
}

function ringSvg(
  width: number,
  height: number,
  ringBox: DemoData["annotatedImage"]["ringBox"]
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="${ringBox.left}" y="${ringBox.top}" width="${ringBox.width}" height="${ringBox.height}" rx="14" fill="none" stroke="${RING_COLOR}" stroke-width="6"/>` +
    "</svg>"
  );
}

async function renderMathImages(
  data: DemoData
): Promise<{ original: Buffer; annotated: Buffer }> {
  const { width, height, ringBox } = data.annotatedImage;
  const base = sharp({
    create: { width, height, channels: 3, background: PAPER_COLOR },
  });
  const ink = Buffer.from(inkSvg(width, height));
  const original = await base
    .clone()
    .composite([{ input: ink }])
    .jpeg({ quality: 88 })
    .toBuffer();
  const annotated = await base
    .clone()
    .composite([{ input: ink }, { input: Buffer.from(ringSvg(width, height, ringBox)) }])
    .jpeg({ quality: 88 })
    .toBuffer();
  return { original, annotated };
}

// Removes exactly the rows the seed created: uploads are found by the demo
// marker, tasks by their source_upload_id (which cascades to task_events and
// starters), weak spots by the ids those tasks point at. Anything the student
// created through the bot lives in different rows and is never touched.
async function wipePreviousDemo(
  client: ReturnType<typeof getSupabase>,
  userId: string,
  bucket: string
): Promise<{ tasks: number; uploads: number; weakSpots: number }> {
  const { data: uploadRows, error } = await client
    .from("uploads")
    .select("id")
    .eq("user_id", userId)
    .eq("text_content", DEMO_UPLOAD_MARKER);
  if (error) throw new Error(`Looking up previous demo uploads failed: ${error.message}`);
  const uploadIds = ((uploadRows ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (uploadIds.length === 0) return { tasks: 0, uploads: 0, weakSpots: 0 };

  const { data: taskRows, error: taskSelectError } = await client
    .from("tasks")
    .select("id, weak_spot_id")
    .eq("user_id", userId)
    .in("source_upload_id", uploadIds);
  if (taskSelectError) {
    throw new Error(`Looking up previous demo tasks failed: ${taskSelectError.message}`);
  }

  const { error: taskDeleteError } = await client
    .from("tasks")
    .delete()
    .eq("user_id", userId)
    .in("source_upload_id", uploadIds);
  if (taskDeleteError) throw new Error(`Deleting previous demo tasks failed: ${taskDeleteError.message}`);

  const weakSpotIds = [
    ...new Set(
      ((taskRows ?? []) as Array<{ weak_spot_id: string | null }>)
        .map((row) => row.weak_spot_id)
        .filter((id): id is string => id != null)
    ),
  ];
  if (weakSpotIds.length > 0) {
    const { error: weakSpotError } = await client
      .from("weak_spots")
      .delete()
      .eq("user_id", userId)
      .in("id", weakSpotIds);
    if (weakSpotError) {
      throw new Error(`Deleting previous demo weak spots failed: ${weakSpotError.message}`);
    }
  }

  // Best effort: the rows are gone either way, an orphaned image only wastes
  // a few KB of storage.
  for (const uploadId of uploadIds) {
    try {
      await client.storage.from(bucket).remove([
        `${userId}/${uploadId}/original.jpg`,
        `${userId}/${uploadId}/annotated.jpg`,
      ]);
    } catch {
      // ignored on purpose
    }
  }

  const { error: uploadDeleteError } = await client
    .from("uploads")
    .delete()
    .eq("user_id", userId)
    .in("id", uploadIds);
  if (uploadDeleteError) {
    throw new Error(`Deleting previous demo uploads failed: ${uploadDeleteError.message}`);
  }

  return {
    tasks: ((taskRows ?? []) as unknown[]).length,
    uploads: uploadIds.length,
    weakSpots: weakSpotIds.length,
  };
}

async function seed(args: SeedArgs): Promise<void> {
  const env = getEnv();
  const data = buildDemoData(new Date(), { demoName: args.name ?? undefined });

  if (!args.apply) {
    for (const line of formatDryRunPlan(args, data, {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
      MODEL_API_KEY: env.MODEL_API_KEY,
    })) {
      console.log(line);
    }
    return;
  }

  const client = getSupabase();
  const q = createQueries(client);
  const bucket = env.SUPABASE_STORAGE_BUCKET;

  // Resolve the user first so --reset knows whose demo rows to remove. An
  // existing first name is kept unless --name says otherwise, so re-running
  // the seed never blanks the account's real name.
  const { data: existingRows, error: existingError } = await client
    .from("users")
    .select()
    .eq("telegram_user_id", args.telegramId)
    .maybeSingle();
  if (existingError) throw new Error(`Looking up the user failed: ${existingError.message}`);
  const existing = (existingRows as UserRow | null) ?? null;

  if (args.reset && existing != null) {
    const wiped = await wipePreviousDemo(client, existing.id, bucket);
    console.log(
      `Reset: removed ${wiped.tasks} previous demo tasks, ${wiped.uploads} demo uploads and ${wiped.weakSpots} demo weak spots.`
    );
  }

  const user = await q.upsertUser({
    telegramUserId: args.telegramId,
    telegramChatId: args.telegramId, // DM chat id equals the user id in Telegram
    firstName: args.name ?? existing?.first_name ?? null,
  });
  console.log(`Seeding as Telegram user ${args.telegramId} (row ${user.id}).`);

  // Uploads first: tasks reference them via source_upload_id.
  const uploadIdByKey = new Map<string, string>();
  for (const upload of data.uploads) {
    const row = await q.createUpload({
      userId: user.id,
      kind: upload.kind,
      mimeType: upload.mimeType,
      textContent: DEMO_UPLOAD_MARKER,
    });
    uploadIdByKey.set(upload.key, row.id);
    if (upload.key === "math-photo") {
      const { original, annotated } = await renderMathImages(data);
      await uploadBuffer(originalPath(user.id, row.id, "jpg"), original, "image/jpeg");
      await uploadBuffer(annotatedPath(user.id, row.id), annotated, "image/jpeg");
      await q.finishUpload(row.id, {
        status: "done",
        classifiedAs: upload.classifiedAs,
        storagePath: originalPath(user.id, row.id, "jpg"),
      });
    } else {
      await q.finishUpload(row.id, { status: "done", classifiedAs: upload.classifiedAs });
    }
  }

  // Weak spots before tasks: the review task points at one. Raw upsert because
  // the query layer's upsertWeakSpot always increments, and the demo needs the
  // exact 3/2/1 counts plus backdated last-seen and next-review times.
  const weakSpotIdByKey = new Map<string, string>();
  for (const spot of data.weakSpots) {
    const { data: row, error } = await client
      .from("weak_spots")
      .upsert(
        {
          user_id: user.id,
          topic: spot.topic,
          latest_misconception: spot.latestMisconception,
          occurrences: spot.occurrences,
          last_seen_at: spot.lastSeenAt,
          next_review_at: spot.nextReviewAt,
        },
        { onConflict: "user_id,topic" }
      )
      .select()
      .single();
    if (error) throw new Error(`Weak spot upsert failed: ${error.message}`);
    weakSpotIdByKey.set(spot.key, (row as { id: string }).id);
  }

  const taskIdByKey = new Map<string, string>();
  for (const task of data.tasks) {
    const row = await q.insertTask({
      userId: user.id,
      title: task.title,
      course: task.course,
      kind: task.kind,
      dueAt: task.dueAt,
      effort: task.effort,
      origin: task.origin,
      sourceUploadId: task.uploadKey == null ? null : (uploadIdByKey.get(task.uploadKey) ?? null),
      weakSpotId: task.weakSpotKey == null ? null : (weakSpotIdByKey.get(task.weakSpotKey) ?? null),
    });
    // The insert layer cannot set created_at/updated_at, and the dashboard's
    // Done group only shows tasks finished in the last week, so backdate.
    const { error } = await client
      .from("tasks")
      .update({ created_at: task.createdAt, updated_at: task.updatedAt, status: task.status })
      .eq("id", row.id);
    if (error) throw new Error(`Backdating task ${task.key} failed: ${error.message}`);
    taskIdByKey.set(task.key, row.id);
  }

  // Raw inserts: task_events.created_at orders the history timeline, and the
  // moved task's update must sort after its creation.
  for (const event of data.taskEvents) {
    const { error } = await client.from("task_events").insert({
      task_id: taskIdByKey.get(event.taskKey) ?? null,
      upload_id: event.uploadKey == null ? null : (uploadIdByKey.get(event.uploadKey) ?? null),
      action: event.action,
      before: event.before,
      after: event.after,
      evidence: event.evidence,
      created_at: event.createdAt,
    });
    if (error) throw new Error(`Task event insert failed: ${error.message}`);
  }

  for (const starter of data.starters) {
    const taskId = taskIdByKey.get(starter.taskKey);
    if (taskId == null) throw new Error(`Starter references unknown task key ${starter.taskKey}`);
    const mathUploadId = uploadIdByKey.get("math-photo");
    await q.insertStarter({
      taskId,
      type: starter.starter.type,
      content: starter.starter.content,
      annotatedImagePath:
        starter.annotated && mathUploadId != null ? annotatedPath(user.id, mathUploadId) : null,
    });
  }

  const open = data.tasks.filter((task) => task.status === "open").length;
  const done = data.tasks.length - open;
  console.log(
    `Seeded ${data.tasks.length} tasks (${open} open, ${done} done), ${data.taskEvents.length} task events, ${data.starters.length} starters and ${data.weakSpots.length} weak spots.`
  );
  console.log("Send /dashboard to the bot to open it.");
}

async function main(): Promise<void> {
  let allowedIds: number[];
  try {
    allowedIds = getEnv().ALLOWED_TELEGRAM_IDS;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  const parsed = parseSeedArgs(process.argv.slice(2), allowedIds);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
    return;
  }

  try {
    await seed(parsed.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
