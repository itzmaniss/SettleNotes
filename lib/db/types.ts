// Hand-written row types mirroring supabase/migrations/0001_init.sql.
// Timestamps are ISO strings (timestamptz over PostgREST), bigint ids are
// numbers (Telegram ids fit in JS safe integers), uuids are strings.

export type UploadKind = "text" | "photo" | "document" | "voice";
export type UploadStatus = "processing" | "done" | "failed";
export type UploadClassifiedAs =
  | "chat_screenshot"
  | "assignment_brief"
  | "lecture_slides"
  | "math_working"
  | "other";

export type TaskKind = "assignment" | "test" | "reading" | "math_practice" | "review" | "other";
export type TaskEffort = "small" | "medium" | "large";
export type TaskStatus = "open" | "done" | "dismissed";
export type TaskOrigin = "capture" | "weak_spot";

export type TaskEventAction = "created" | "updated" | "completed" | "reopened";

export type StarterType = "checklist" | "flashcards" | "math_diagnosis" | "review_practice";

export type UserRow = {
  id: string;
  telegram_user_id: number;
  telegram_chat_id: number;
  first_name: string | null;
  timezone: string;
  // Set together the moment the person accepts the current Terms and Privacy
  // Policy. Null on rows from before migration 0004 means not accepted yet.
  terms_accepted_at: string | null;
  terms_version: string | null;
  created_at: string;
};

export type UploadRow = {
  id: string;
  user_id: string;
  kind: UploadKind;
  telegram_file_id: string | null;
  mime_type: string | null;
  storage_path: string | null;
  text_content: string | null;
  classified_as: string | null;
  status: UploadStatus;
  error: string | null;
  created_at: string;
};

export type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  course: string | null;
  kind: TaskKind;
  due_at: string | null;
  effort: TaskEffort | null;
  status: TaskStatus;
  origin: TaskOrigin;
  source_upload_id: string | null;
  weak_spot_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskEventRow = {
  id: string;
  task_id: string;
  upload_id: string | null;
  action: TaskEventAction;
  before: unknown;
  after: unknown;
  evidence: string | null;
  created_at: string;
};

export type StarterRow = {
  id: string;
  task_id: string;
  type: StarterType;
  content: unknown;
  annotated_image_path: string | null;
  created_at: string;
};

export type WeakSpotRow = {
  id: string;
  user_id: string;
  topic: string;
  latest_misconception: string;
  occurrences: number;
  last_seen_at: string;
  next_review_at: string | null;
};

export type LoginTokenRow = {
  token_hash: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
};

export type AiCallRow = {
  id: string;
  user_id: string | null;
  purpose: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  audio_seconds: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  ok: boolean;
  created_at: string;
};
