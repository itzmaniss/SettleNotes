// Result shape shared by every dashboard server action. Errors are plain
// human sentences, safe to show the student as-is.
export type ActionResult = { ok: true } | { ok: false; error: string };
