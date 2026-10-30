import Link from "next/link";
import { Chunk } from "@/components/settle";
import { formatSgtDateShort } from "@/lib/dashboard/format";
import { isRecurring, weakSpotPips } from "@/lib/dashboard/weak-spots";
import { MATH_TOPIC_LABELS, type MathTopic } from "@/lib/starters/types";
import type { WeakSpotRow } from "@/lib/db/types";
import { cn } from "@/lib/utils";
import { EmptyNote } from "./empty-note";

function topicLabel(topic: string): string {
  return topic in MATH_TOPIC_LABELS ? MATH_TOPIC_LABELS[topic as MathTopic] : topic;
}

function WeakSpotRowItem({ spot }: { spot: WeakSpotRow }) {
  const pips = weakSpotPips(spot.occurrences);
  const recurring = isRecurring(spot.occurrences);
  const review = spot.next_review_at != null ? formatSgtDateShort(spot.next_review_at) : "";
  return (
    <li>
      {/* Narrow screens: the topic gets its own full-width line and the meta
          counts sit beneath it (smaller, allowed to wrap); sm and up keep the
          single row. Recurring is named in words, not colour alone. */}
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <span className="font-medium sm:whitespace-nowrap">{topicLabel(spot.topic)}</span>
        <span
          className={cn(
            "font-mono text-[11px] leading-snug sm:shrink-0 sm:text-xs",
            recurring && "text-destructive",
          )}
        >
          {spot.occurrences}×{recurring ? " · recurring" : ""}
          {review !== "" ? ` · review ${review}` : ""}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1" aria-hidden="true">
        {Array.from({ length: pips.segments }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-2 flex-1 rounded-full",
              index < pips.filled ? (recurring ? "bg-destructive" : "bg-pop") : "bg-muted",
            )}
          />
        ))}
      </div>
      <span className="sr-only">{spot.occurrences} occurrences</span>
    </li>
  );
}

export function WeakSpotsPanel({ spots }: { spots: WeakSpotRow[] }) {
  if (spots.length === 0) {
    return (
      <EmptyNote>
        No weak spots yet. Send a photo of your math working and I will spot the patterns.
      </EmptyNote>
    );
  }
  return (
    <Chunk className="mt-3 p-5">
      <ul className="space-y-4">
        {spots.map((spot) => (
          <WeakSpotRowItem key={spot.id} spot={spot} />
        ))}
      </ul>
      <Link
        href="/weak-spots"
        className="mt-4 inline-flex min-h-[44px] items-center text-sm font-semibold underline underline-offset-4"
      >
        See all
      </Link>
    </Chunk>
  );
}
