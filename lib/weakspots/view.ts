// Pure view-model mapping for the weak-spots page: db rows in, display-ready
// items out. No server-only, so unit tests import it directly. Row order is
// preserved; the list query already sorts occurrences desc then last seen.

import type { TaskRow, WeakSpotRow } from "@/lib/db/types";
import { formatDueLine, formatSgtDateShort } from "@/lib/dashboard/format";
import { isRecurring, weakSpotPips, type Pips } from "@/lib/dashboard/weak-spots";
import { MATH_TOPIC_LABELS, type MathTopic } from "@/lib/starters/types";

export type WeakSpotReviewLine =
  | { kind: "task"; href: string; text: string }
  | { kind: "scheduled"; text: string }
  | { kind: "none"; text: string };

export type WeakSpotViewItem = {
  id: string;
  topicLabel: string;
  occurrences: number;
  timesLine: string;
  pips: Pips;
  recurring: boolean;
  lastSeenLine: string;
  misconception: string;
  review: WeakSpotReviewLine;
};

export function weakSpotTopicLabel(topic: string): string {
  return topic in MATH_TOPIC_LABELS ? MATH_TOPIC_LABELS[topic as MathTopic] : topic;
}

// An open review task wins (it is the thing to act on), else the stored
// next_review_at date, else nothing scheduled yet.
export function buildWeakSpotViewItems(
  spots: WeakSpotRow[],
  openReviewTaskByWeakSpotId: Map<string, TaskRow>,
  now: Date
): WeakSpotViewItem[] {
  return spots.map((spot) => {
    const task = openReviewTaskByWeakSpotId.get(spot.id) ?? null;
    let review: WeakSpotReviewLine;
    if (task != null) {
      review = {
        kind: "task",
        href: `/tasks/${task.id}`,
        text: `Review due ${formatDueLine(task.due_at, now).text}`,
      };
    } else if (spot.next_review_at != null) {
      const date = formatSgtDateShort(spot.next_review_at);
      review = date === ""
        ? { kind: "none", text: "No review scheduled" }
        : { kind: "scheduled", text: `Next review ${date}` };
    } else {
      review = { kind: "none", text: "No review scheduled" };
    }
    return {
      id: spot.id,
      topicLabel: weakSpotTopicLabel(spot.topic),
      occurrences: spot.occurrences,
      timesLine: spot.occurrences === 1 ? "1 time" : `${spot.occurrences} times`,
      pips: weakSpotPips(spot.occurrences),
      recurring: isRecurring(spot.occurrences),
      lastSeenLine: `last seen ${formatSgtDateShort(spot.last_seen_at)}`,
      misconception: spot.latest_misconception,
      review,
    };
  });
}
