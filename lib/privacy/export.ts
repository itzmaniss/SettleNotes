// The access export: one plain JSON object with everything the student is
// entitled to see. Read only: every query filters on the subject's id and
// nothing here, or in the script that calls it, ever writes. Login tokens are
// security material and are never read; anything belonging to another user
// can never appear because every query carries the user filter.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPaged } from "./query";
import { listStoredFiles, type StorageApi } from "./storage";

export type ExportDeps = { storage?: StorageApi; bucket?: string; now?: () => Date };

// Matches the SUPABASE_STORAGE_BUCKET default in lib/env.ts; the script
// passes the configured value explicitly.
export const DEFAULT_EXPORT_BUCKET = "uploads";

export const EXPORT_NOTE =
  "Produced by the operator of this Settle deployment on the date in exported_at. " +
  "Included: the account row, uploads with their text and classification, tasks, task events, " +
  "starters, weak spots, subscriptions, usage events, pending actions, purchase confirmations, " +
  "a summary of AI usage, " +
  "and the list of files stored for this account. " +
  "Not included: login tokens and other security material, raw AI prompts and responses, " +
  "other students' data, signed file links, and the operator side payment records, which are " +
  "kept for accounting with personal details removed.";

export type ExportUserRow = {
  id: string;
  telegram_user_id: number;
  telegram_chat_id: number;
  first_name: string | null;
  timezone: string;
  terms_accepted_at: string | null;
  terms_version: string | null;
  created_at: string;
};

export type UploadExportRow = {
  id: string;
  kind: string;
  mime_type: string | null;
  storage_path: string | null;
  text_content: string | null;
  classified_as: string | null;
  status: string;
  error: string | null;
  created_at: string;
};

export type TaskExportRow = {
  id: string;
  title: string;
  course: string | null;
  kind: string;
  due_at: string | null;
  effort: string | null;
  status: string;
  origin: string;
  source_upload_id: string | null;
  weak_spot_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskEventExportRow = {
  id: string;
  task_id: string;
  upload_id: string | null;
  action: string;
  before: unknown;
  after: unknown;
  evidence: string | null;
  created_at: string;
};

export type StarterExportRow = {
  id: string;
  task_id: string;
  type: string;
  content: unknown;
  annotated_image_path: string | null;
  created_at: string;
};

export type WeakSpotExportRow = {
  id: string;
  topic: string;
  latest_misconception: string;
  occurrences: number;
  last_seen_at: string;
  next_review_at: string | null;
};

export type SubscriptionExportRow = {
  provider: string;
  provider_ref: string;
  plan: string;
  status: string;
  current_period_end: string | null;
  created_at: string;
};

export type UsageEventExportRow = {
  feature: string;
  status: string;
  upload_id: string | null;
  created_at: string;
};

export type PendingActionExportRow = {
  kind: string;
  payload: unknown;
  status: string;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
};

export type PurchaseConfirmationExportRow = {
  channel: string;
  terms_version: string;
  confirmed_at: string;
};

export type AiCallExportRow = {
  purpose: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
};

export type AiCallsExportSummary = {
  count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  by_purpose: Record<
    string,
    { count: number; total_input_tokens: number; total_output_tokens: number; total_cost_usd: number }
  >;
};

export type PrivacyExport = {
  exported_at: string;
  note: string;
  account: ExportUserRow;
  uploads: UploadExportRow[];
  tasks: TaskExportRow[];
  task_events: TaskEventExportRow[];
  starters: StarterExportRow[];
  weak_spots: WeakSpotExportRow[];
  subscriptions: SubscriptionExportRow[];
  usage_events: UsageEventExportRow[];
  pending_actions: PendingActionExportRow[];
  purchase_confirmations: PurchaseConfirmationExportRow[];
  ai_calls_summary: AiCallsExportSummary;
  files: string[];
};

export function summarizeAiCallsForExport(rows: AiCallExportRow[]): AiCallsExportSummary {
  const byPurpose: AiCallsExportSummary["by_purpose"] = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  for (const row of rows) {
    const input = row.input_tokens ?? 0;
    const output = row.output_tokens ?? 0;
    const rowCost = row.cost_usd ?? 0;
    inputTokens += input;
    outputTokens += output;
    cost += rowCost;
    const bucket = byPurpose[row.purpose] ?? {
      count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
    };
    bucket.count += 1;
    bucket.total_input_tokens += input;
    bucket.total_output_tokens += output;
    bucket.total_cost_usd += rowCost;
    byPurpose[row.purpose] = bucket;
  }
  for (const bucket of Object.values(byPurpose)) {
    bucket.total_cost_usd = Math.round(bucket.total_cost_usd * 1e6) / 1e6;
  }
  return {
    count: rows.length,
    total_input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    // Six decimal places is the column's precision; rounding kills float drift.
    total_cost_usd: Math.round(cost * 1e6) / 1e6,
    by_purpose: byPurpose,
  };
}

// The embedded tasks!inner join is needed for the user filter but adds a
// redundant tasks key to each row; these pickers strip it, so the export
// carries exactly the columns named in the select.
function pickTaskEvent(row: Record<string, unknown>): TaskEventExportRow {
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    upload_id: (row.upload_id as string | null) ?? null,
    action: row.action as string,
    before: row.before,
    after: row.after,
    evidence: (row.evidence as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

function pickStarter(row: Record<string, unknown>): StarterExportRow {
  return {
    id: row.id as string,
    task_id: row.task_id as string,
    type: row.type as string,
    content: row.content,
    annotated_image_path: (row.annotated_image_path as string | null) ?? null,
    created_at: row.created_at as string,
  };
}

export async function buildExport(
  client: SupabaseClient,
  userId: string,
  deps: ExportDeps = {},
): Promise<PrivacyExport> {
  const storage = deps.storage ?? (client as unknown as { storage?: StorageApi }).storage;
  if (storage == null) {
    throw new Error("No storage client available for the file list; inject one in deps.storage.");
  }
  const bucket = deps.bucket ?? DEFAULT_EXPORT_BUCKET;
  const eqUser = [{ column: "user_id", op: "eq" as const, value: userId }];
  const viaTasks = [{ column: "tasks.user_id", op: "eq" as const, value: userId }];

  // The account row itself. No secrets live on it; the identifiers are the
  // student's own data and belong in their export.
  const userRows = await fetchPaged<ExportUserRow>(
    client,
    "users",
    "id,telegram_user_id,telegram_chat_id,first_name,timezone,terms_accepted_at,terms_version,created_at",
    [{ column: "id", op: "eq", value: userId }],
  );
  const account = userRows[0];
  if (account == null) {
    throw new Error("The users row is missing; resolve the subject before exporting.");
  }

  const uploads = await fetchPaged<UploadExportRow>(
    client,
    "uploads",
    "id,kind,mime_type,storage_path,text_content,classified_as,status,error,created_at",
    eqUser,
    "created_at",
  );
  const tasks = await fetchPaged<TaskExportRow>(
    client,
    "tasks",
    "id,title,course,kind,due_at,effort,status,origin,source_upload_id,weak_spot_id,created_at,updated_at",
    eqUser,
    "created_at",
  );
  // task_events and starters hang off tasks, so the user filter goes through
  // the inner join, exactly as in countOwnedRows.
  const taskEventRows = await fetchPaged<Record<string, unknown>>(
    client,
    "task_events",
    "id,task_id,upload_id,action,before,after,evidence,created_at,tasks!inner(user_id)",
    viaTasks,
    "created_at",
  );
  const starterRows = await fetchPaged<Record<string, unknown>>(
    client,
    "starters",
    "id,task_id,type,content,annotated_image_path,created_at,tasks!inner(user_id)",
    viaTasks,
    "created_at",
  );
  const weakSpots = await fetchPaged<WeakSpotExportRow>(
    client,
    "weak_spots",
    "id,topic,latest_misconception,occurrences,last_seen_at,next_review_at",
    eqUser,
    "last_seen_at",
  );
  const subscriptions = await fetchPaged<SubscriptionExportRow>(
    client,
    "subscriptions",
    "provider,provider_ref,plan,status,current_period_end,created_at",
    eqUser,
    "created_at",
  );
  const usageEvents = await fetchPaged<UsageEventExportRow>(
    client,
    "usage_events",
    "feature,status,upload_id,created_at",
    eqUser,
    "created_at",
  );
  const pendingActions = await fetchPaged<PendingActionExportRow>(
    client,
    "pending_actions",
    "kind,payload,status,expires_at,created_at,resolved_at",
    eqUser,
    "created_at",
  );
  const purchaseConfirmations = await fetchPaged<PurchaseConfirmationExportRow>(
    client,
    "purchase_confirmations",
    "channel,terms_version,confirmed_at",
    eqUser,
    "confirmed_at",
  );
  // Only the aggregate is exported, never the individual AI call rows.
  const aiRows = await fetchPaged<AiCallExportRow>(
    client,
    "ai_calls",
    "purpose,input_tokens,output_tokens,cached_tokens,cost_usd",
    eqUser,
  );
  const files = await listStoredFiles(storage, bucket, userId);

  return {
    exported_at: (deps.now ?? (() => new Date()))().toISOString(),
    note: EXPORT_NOTE,
    account,
    uploads,
    tasks,
    task_events: taskEventRows.map(pickTaskEvent),
    starters: starterRows.map(pickStarter),
    weak_spots: weakSpots,
    subscriptions,
    usage_events: usageEvents,
    pending_actions: pendingActions,
    purchase_confirmations: purchaseConfirmations,
    ai_calls_summary: summarizeAiCallsForExport(aiRows),
    files,
  };
}
