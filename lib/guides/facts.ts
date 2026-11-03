// The product numbers the guide copy quotes, mirrored here so the pages and
// the tests never import sharp or ffmpeg to render an article. The values are
// pinned to the real constants by tests/guides/facts.test.ts, which imports
// both sides, so a change in lib/billing/plans.ts or lib/media breaks the
// test run instead of drifting silently on the page.
//
// free_math, free_slides, free_briefs: PLANS.free.quotas in
// lib/billing/plans.ts (math_diagnosis, slides_flashcards, brief_checklist).
// pdf_pages: MAX_PDF_PAGES in lib/media/normalize.ts.
// voice_minutes: MAX_VOICE_SECONDS / 60 in lib/media/audio.ts.
export const GUIDE_TOKEN_NAMES = [
  "free_math",
  "free_slides",
  "free_briefs",
  "pdf_pages",
  "voice_minutes",
] as const;

export type GuideTokenName = (typeof GUIDE_TOKEN_NAMES)[number];

export type GuideFacts = Record<GuideTokenName, string>;

export const GUIDE_FACTS: GuideFacts = {
  free_math: "3",
  free_slides: "1",
  free_briefs: "1",
  pdf_pages: "50",
  voice_minutes: "3",
};
