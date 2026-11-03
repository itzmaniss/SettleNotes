import { describe, expect, test } from "bun:test";

import { MAX_PDF_PAGES } from "@/lib/media/normalize";
import { MAX_VOICE_SECONDS } from "@/lib/media/audio";
import { PLANS } from "@/lib/billing/plans";
import { GUIDE_FACTS, GUIDE_TOKEN_NAMES } from "@/lib/guides/facts";

// The leaf facts mirror constants that live in heavier modules (sharp, the
// ffmpeg binary). The page never imports those, so this test imports both
// sides and pins the copy numbers to the code they describe.
describe("guide facts equal the real constants", () => {
  test("the free plan quotas", () => {
    expect(GUIDE_FACTS.free_math).toBe(String(PLANS.free.quotas.math_diagnosis));
    expect(GUIDE_FACTS.free_slides).toBe(String(PLANS.free.quotas.slides_flashcards));
    expect(GUIDE_FACTS.free_briefs).toBe(String(PLANS.free.quotas.brief_checklist));
  });

  test("the pdf page cap", () => {
    expect(Number(GUIDE_FACTS.pdf_pages)).toBe(MAX_PDF_PAGES);
  });

  test("the voice limit, in whole minutes", () => {
    expect(Number(GUIDE_FACTS.voice_minutes) * 60).toBe(MAX_VOICE_SECONDS);
    expect(MAX_VOICE_SECONDS % 60).toBe(0);
  });

  test("the token table covers exactly the five names the copy uses", () => {
    expect(Object.keys(GUIDE_FACTS).sort()).toEqual([...GUIDE_TOKEN_NAMES].sort());
    for (const name of GUIDE_TOKEN_NAMES) {
      expect(GUIDE_FACTS[name].trim().length).toBeGreaterThan(0);
    }
  });
});
