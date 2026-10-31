import Link from "next/link";
import { Chunk, Sticker } from "@/components/settle";
import { MixedMath } from "@/components/dashboard/mixed-math";
import { cn } from "@/lib/utils";
import type { WeakSpotViewItem } from "@/lib/weakspots/view";

// One topic per Chunk. The topic label is a block heading, so it sits on its
// own line at every width; pips and metadata stack beneath, tap targets on
// the review link stay at 44px.
export function WeakSpotCard({ item }: { item: WeakSpotViewItem }) {
  return (
    <Chunk className="p-5">
      <h3 className="font-display text-lg font-extrabold leading-tight">{item.topicLabel}</h3>
      <div className="mt-2 flex max-w-44 gap-1" aria-hidden="true">
        {Array.from({ length: item.pips.segments }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-2 flex-1 rounded-full",
              index < item.pips.filled ? (item.recurring ? "bg-destructive" : "bg-pop") : "bg-muted",
            )}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {item.recurring && <Sticker tone="destructive">recurring</Sticker>}
        <span className="font-mono text-xs">{item.timesLine}</span>
        <span className="text-xs text-muted-foreground">{item.lastSeenLine}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        <MixedMath text={item.misconception} />
      </p>
      <div className="mt-3">
        {item.review.kind === "task" ? (
          <Link
            href={item.review.href}
            className="inline-flex min-h-[44px] items-center text-sm font-semibold underline underline-offset-4"
          >
            {item.review.text}
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">{item.review.text}</p>
        )}
      </div>
    </Chunk>
  );
}
