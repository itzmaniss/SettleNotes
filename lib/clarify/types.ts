// Types and validation for stored low-confidence actions (pending_actions
// table, migration 0003). Row types live here, not in lib/db/types.ts, so the
// clarify feature owns its own contract. `payload` never carries raw model
// output beyond these fields, and it is zod-validated on read before anything
// is applied.

import { z } from "zod";

export type PendingActionKind = "create" | "update" | "complete";
export type PendingActionStatus = "pending" | "accepted" | "dismissed";

// What a confident create writes, frozen at prompt time. dueAt is a UTC ISO
// instant or null; the caller converts due_local before building this.
export const CreatePendingPayloadSchema = z.strictObject({
  title: z.string().min(1),
  course: z.string().nullable(),
  kind: z.enum(["assignment", "test", "reading", "math_practice", "other"]),
  dueAt: z.string().nullable(),
  effort: z.enum(["small", "medium", "large"]).nullable(),
  evidence: z.string(),
});

// Only the fields the student is being asked to confirm. An update with
// neither a title nor a due date is never stored (nothing to apply).
export const UpdatePendingPayloadSchema = z.strictObject({
  dueAt: z.string().optional(),
  title: z.string().optional(),
  evidence: z.string(),
});

export const CompletePendingPayloadSchema = z.strictObject({
  evidence: z.string(),
});

// Per-kind schemas: pick with the row's kind column, then validate payload.
export const PendingPayloadSchema = {
  create: CreatePendingPayloadSchema,
  update: UpdatePendingPayloadSchema,
  complete: CompletePendingPayloadSchema,
} as const;

export type CreatePendingPayload = z.infer<typeof CreatePendingPayloadSchema>;
export type UpdatePendingPayload = z.infer<typeof UpdatePendingPayloadSchema>;
export type CompletePendingPayload = z.infer<typeof CompletePendingPayloadSchema>;

// The parsed result pairs the row's kind with its validated payload (kept
// separate because a create payload's own `kind` field is the task kind).
export type ParsedPendingPayload =
  | { kind: "create"; payload: CreatePendingPayload }
  | { kind: "update"; payload: UpdatePendingPayload }
  | { kind: "complete"; payload: CompletePendingPayload };

/** Validates a stored payload against its kind's schema; null when unusable. */
export function parsePendingPayload(
  kind: PendingActionKind,
  raw: unknown,
): ParsedPendingPayload | null {
  const parsed = PendingPayloadSchema[kind].safeParse(raw);
  if (!parsed.success) return null;
  return { kind, payload: parsed.data } as ParsedPendingPayload;
}

// What the build step hands to the query layer. The real insert returns the
// row so the caller can link the prompt message to it via the generated id.
export type PendingActionInput = {
  userId: string;
  uploadId: string | null;
  kind: PendingActionKind;
  taskId: string | null;
  payload: CreatePendingPayload | UpdatePendingPayload | CompletePendingPayload;
};

export type PendingActionRow = {
  id: string;
  user_id: string;
  upload_id: string | null;
  kind: PendingActionKind;
  task_id: string | null;
  payload: unknown;
  status: PendingActionStatus;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
};
