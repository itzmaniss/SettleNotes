import { EmptyNote } from "@/components/dashboard/empty-note";
import type { WeakSpotViewItem } from "@/lib/weakspots/view";
import { WeakSpotCard } from "./weak-spot-card";

export const WEAK_SPOTS_EMPTY_TEXT =
  "No weak spots yet. Send me a photo of your math working and I will start tracking what trips you up.";

// One column on phones, two Chunks wide from md. Row order comes from the
// query: occurrences desc, then last seen.
export function WeakSpotsList({ items }: { items: WeakSpotViewItem[] }) {
  if (items.length === 0) {
    return <EmptyNote>{WEAK_SPOTS_EMPTY_TEXT}</EmptyNote>;
  }
  return (
    <div className="mt-5 grid gap-4 md:grid-cols-2 md:gap-5">
      {items.map((item) => (
        <WeakSpotCard key={item.id} item={item} />
      ))}
    </div>
  );
}
