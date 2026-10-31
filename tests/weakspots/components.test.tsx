import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WeakSpotCard } from "@/components/weakspots/weak-spot-card";
import { WEAK_SPOTS_EMPTY_TEXT, WeakSpotsList } from "@/components/weakspots/weak-spots-list";
import type { TaskRow, WeakSpotRow } from "@/lib/db/types";
import { buildWeakSpotViewItems } from "@/lib/weakspots/view";
import { task, weakSpot } from "../dashboard/fixtures";

// Noon SGT, Tuesday 3 November 2026.
const NOW = new Date("2026-11-03T04:00:00.000Z");

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function spot(overrides: Partial<WeakSpotRow> = {}): WeakSpotRow {
  return weakSpot({ id: "spot-1", occurrences: 1, ...overrides });
}

function assertNoDashes(html: string): void {
  expect(html.includes("\u2014")).toBe(false);
  expect(html.includes("\u2013")).toBe(false);
}

describe("WeakSpotCard", () => {
  test("topic label sits in its own block heading above pips and counts", () => {
    const [item] = buildWeakSpotViewItems([spot()], new Map(), NOW);
    const html = render(<WeakSpotCard item={item} />);
    expect(html).toMatch(/<h3[^>]*>Chain rule<\/h3>/);
    expect(html).toContain("1 time");
    expect(html).toContain("last seen Fri 30 Oct");
    expect(html).toContain("forgot the inner derivative");
    assertNoDashes(html);
  });

  test("recurring sticker appears only at three or more, pips fill up to five", () => {
    const [calm] = buildWeakSpotViewItems([spot({ occurrences: 2 })], new Map(), NOW);
    const calmHtml = render(<WeakSpotCard item={calm} />);
    expect(calmHtml).not.toContain(">recurring<");
    expect(calmHtml).toContain("2 times");

    const [chronic] = buildWeakSpotViewItems([spot({ occurrences: 3 })], new Map(), NOW);
    const chronicHtml = render(<WeakSpotCard item={chronic} />);
    expect(chronicHtml).toContain(">recurring<");
    expect(chronicHtml).toContain("bg-destructive");
    expect(chronicHtml).toContain("3 times");
  });

  test("an open review task renders a 44px link with the due line", () => {
    const openTask: TaskRow = task({ id: "review-9", kind: "review", due_at: "2026-11-05T15:59:00.000Z" });
    const [item] = buildWeakSpotViewItems([spot()], new Map([["spot-1", openTask]]), NOW);
    const html = render(<WeakSpotCard item={item} />);
    expect(html).toContain('href="/tasks/review-9"');
    expect(html).toContain("Review due Thu 5 Nov, 11:59pm");
    expect(html).toContain("min-h-[44px]");
    assertNoDashes(html);
  });

  test("without a task the next review date or the nothing-scheduled line shows", () => {
    const [scheduled] = buildWeakSpotViewItems([spot()], new Map(), NOW);
    expect(render(<WeakSpotCard item={scheduled} />)).toContain("Next review Fri 6 Nov");

    const [none] = buildWeakSpotViewItems([spot({ next_review_at: null })], new Map(), NOW);
    expect(render(<WeakSpotCard item={none} />)).toContain("No review scheduled");
  });
});

describe("WeakSpotsList", () => {
  test("friendly empty state with no dashes", () => {
    const html = render(<WeakSpotsList items={[]} />);
    expect(html).toContain(WEAK_SPOTS_EMPTY_TEXT);
    expect(WEAK_SPOTS_EMPTY_TEXT).toBe(
      "No weak spots yet. Send me a photo of your math working and I will start tracking what trips you up.",
    );
    assertNoDashes(html);
  });

  test("one Chunk per topic, ordered as given", () => {
    const items = buildWeakSpotViewItems(
      [spot({ id: "a", occurrences: 1 }), spot({ id: "b", occurrences: 4, topic: "fractions" })],
      new Map(),
      NOW,
    );
    const html = render(<WeakSpotsList items={items} />);
    expect(html.indexOf("Chain rule")).toBeLessThan(html.indexOf("Fractions"));
    expect(html).toContain("4 times");
    assertNoDashes(html);
  });
});
