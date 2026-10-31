import type { Metadata } from "next";
import { requireSessionUser } from "@/lib/auth/session";
import { listWeakSpotsForUser } from "@/lib/db/dashboard-queries";
import type { TaskRow } from "@/lib/db/types";
import { listOpenReviewTasksByWeakSpot } from "@/lib/weakspots/queries";
import { buildWeakSpotViewItems } from "@/lib/weakspots/view";
import { WeakSpotsList } from "@/components/weakspots/weak-spots-list";

export const metadata: Metadata = {
  title: "Weak spots",
};

// PRD F4's weak-spots page: every topic that tripped the student up, how
// often, when it was last seen, and where its next review stands.
export default async function WeakSpotsPage() {
  const { userId } = await requireSessionUser();
  const now = new Date();

  const spots = await listWeakSpotsForUser(userId);
  const tasks = await listOpenReviewTasksByWeakSpot(
    userId,
    spots.map((spot) => spot.id)
  );
  const taskByWeakSpotId = new Map<string, TaskRow>();
  for (const task of tasks) {
    if (task.weak_spot_id != null && !taskByWeakSpotId.has(task.weak_spot_id)) {
      taskByWeakSpotId.set(task.weak_spot_id, task);
    }
  }

  const items = buildWeakSpotViewItems(spots, taskByWeakSpotId, now);

  return (
    <div className="pt-4">
      <header>
        <h1 className="font-display text-3xl font-extrabold leading-tight md:text-4xl">
          Weak spots
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          What keeps tripping you up, and when I bring each one back.
        </p>
      </header>
      <WeakSpotsList items={items} />
    </div>
  );
}
