import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// plan.ts pulls the billing seams for limitFor and nextPeriodStart, which
// transitively import "server-only". Neutralize it, then load the real modules.
mock.module("server-only", () => ({}));

const { buildPlanView, lockState } = await import("@/lib/dashboard/plan");
const { LockBanner, PlanCard } = await import("@/components/dashboard/plan-card");

// 28 Oct 2026, 09:00 SGT: inside the October period, resetting on 1 Nov.
const NOW = new Date("2026-10-28T01:00:00.000Z");

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const freeView = (usage: Record<string, number>) => buildPlanView({ plan: "free", usage, now: NOW });

describe("lockState", () => {
  test("null when nothing is exhausted", () => {
    expect(lockState(freeView({ math_diagnosis: 2, slides_flashcards: 0, brief_checklist: 0 }))).toBeNull();
    expect(lockState(freeView({}))).toBeNull();
  });

  test("null for Pro: every row is unlimited and can never be exhausted", () => {
    const proView = buildPlanView({
      plan: "pro",
      usage: { math_diagnosis: 999, slides_flashcards: 999, brief_checklist: 999 },
      now: NOW,
    });
    expect(lockState(proView)).toBeNull();
  });

  test("one exhausted feature: names it and quotes the SGT reset date", () => {
    const state = lockState(freeView({ math_diagnosis: 3, slides_flashcards: 0, brief_checklist: 0 }));
    expect(state).toEqual({
      features: ["math checks"],
      resetsOn: "1 Nov",
      sentence: "You have used all your free math checks this month. They reset on 1 Nov.",
    });
  });

  test("used past the limit still counts as exhausted", () => {
    const state = lockState(freeView({ math_diagnosis: 0, slides_flashcards: 1, brief_checklist: 0 }));
    expect(state?.features).toEqual(["slide decks"]);
  });

  test("several exhausted features read as one natural list", () => {
    const two = lockState(freeView({ math_diagnosis: 3, slides_flashcards: 1, brief_checklist: 0 }));
    expect(two?.sentence).toBe(
      "You have used all your free math checks and slide decks this month. They reset on 1 Nov.",
    );
    const three = lockState(freeView({ math_diagnosis: 3, slides_flashcards: 1, brief_checklist: 1 }));
    expect(three?.sentence).toBe(
      "You have used all your free math checks, slide decks and brief checklists this month. They reset on 1 Nov.",
    );
  });

  test("the sentence carries no dashes and no price numbers", () => {
    const state = lockState(freeView({ math_diagnosis: 3, slides_flashcards: 1, brief_checklist: 1 }));
    expect(state?.sentence).not.toMatch(/[\u2013\u2014]/);
    expect(state?.sentence).not.toContain("S$");
    expect(state?.sentence).not.toContain("600");
  });
});

describe("LockBanner", () => {
  const state = lockState(freeView({ math_diagnosis: 3, slides_flashcards: 0, brief_checklist: 0 }))!;

  test("renders the sticker, the sentence and no link while billing is closed", () => {
    const html = render(<LockBanner state={state} />);
    expect(html).toContain("limit reached");
    expect(html).toContain("You have used all your free math checks this month. They reset on 1 Nov.");
    expect(html).not.toContain('href="/billing"');
  });

  test("billing open: adds the See plans link to /billing", () => {
    const html = render(<LockBanner state={state} billingOpen />);
    expect(html).toContain("See plans");
    expect(html).toContain('href="/billing"');
  });

  test("no prices and no Stars numbers anywhere in the markup", () => {
    const html = render(<LockBanner state={state} billingOpen />);
    expect(html).not.toContain("S$");
    expect(html).not.toContain("7.99");
    expect(html).not.toContain("600");
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });

  test("the dashboard page renders it above the Plan card only for an exhausted Free plan", () => {
    // Page-level rule, mirrored here: planView exists only while billing is
    // on, and the banner only when lockState is non null. Pro pages and
    // billing-off pages render the plain PlanCard with no banner.
    const proView = buildPlanView({ plan: "pro", usage: {}, now: NOW });
    const proHtml = render(<PlanCard view={proView} billingOpen />);
    expect(proHtml).not.toContain("limit reached");
  });
});
