import { requireSessionUser } from "@/lib/auth/session";
import { scoreTask } from "@/lib/pipeline/priority";
import {
  listDashboardTasks,
  listLatestEventsForTasks,
  listStudyDecks,
  listWeakSpotsForUser,
} from "@/lib/db/dashboard-queries";
import { groupForDashboard, pickNextUp } from "@/lib/dashboard/next-up";
import { studyDeckSummary } from "@/lib/dashboard/study-decks";
import { Eyebrow } from "@/components/dashboard/eyebrow";
import { NextUpCard, NextUpEmpty } from "@/components/dashboard/next-up-card";
import { TaskRowCard } from "@/components/dashboard/task-row";
import { QuickStudy } from "@/components/dashboard/quick-study";
import { WeakSpotsPanel } from "@/components/dashboard/weak-spots-panel";
import { EmptyNote } from "@/components/dashboard/empty-note";
import type { TaskEventRow } from "@/lib/db/types";

// The mock's #dash view. Source order is the mobile one-column order:
// Next up, This week, Quick study, Weak spots; md up becomes two columns.
export default async function DashboardPage() {
  const { userId } = await requireSessionUser();
  const now = new Date();

  const tasks = await listDashboardTasks(userId);
  const nextUp = pickNextUp(tasks, now);
  const sections = groupForDashboard(tasks, now);

  const latestEvents = await listLatestEventsForTasks(
    userId,
    tasks.filter((task) => task.status === "open").map((task) => task.id),
  );
  const eventByTaskId = new Map<string, TaskEventRow>(
    latestEvents.map((event) => [event.task_id, event]),
  );

  const decks = await listStudyDecks(userId);
  decks.sort((a, b) => scoreTask(b.task, now) - scoreTask(a.task, now));
  const summaries = studyDeckSummary(decks);

  const weakSpots = await listWeakSpotsForUser(userId);

  return (
    <div className="pt-4">
      <h1 className="sr-only">Your week</h1>
      <div className="grid gap-10 md:grid-cols-[1.3fr_1fr] md:gap-10">
        <div>
          <section aria-labelledby="next-up-heading">
            <Eyebrow id="next-up-heading">Next up</Eyebrow>
            <div className="mt-3">
              {nextUp != null ? (
                <NextUpCard task={nextUp} lastEvent={eventByTaskId.get(nextUp.id) ?? null} now={now} />
              ) : (
                <NextUpEmpty hasTasks={tasks.length > 0} />
              )}
            </div>
          </section>

          <section aria-labelledby="this-week-heading" className="mt-10">
            <Eyebrow id="this-week-heading">This week</Eyebrow>
            {sections.length === 0 ? (
              <div className="mt-3">
                <EmptyNote>Ticked off and cleared. Fresh deadlines show up here.</EmptyNote>
              </div>
            ) : (
              <div className="mt-3 space-y-6">
                {sections.map((section) => (
                  <div key={section.bucket}>
                    {section.bucket !== "this_week" && (
                      <p className="mb-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                        {section.label}
                      </p>
                    )}
                    <div className="space-y-3">
                      {section.tasks.map((task) => (
                        <TaskRowCard
                          key={task.id}
                          task={task}
                          lastEvent={eventByTaskId.get(task.id) ?? null}
                          now={now}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="space-y-10">
          <section id="study" aria-labelledby="study-heading" className="scroll-mt-24">
            <Eyebrow id="study-heading">Quick study</Eyebrow>
            <QuickStudy decks={summaries} />
          </section>

          <section aria-labelledby="weak-spots-heading">
            <Eyebrow id="weak-spots-heading">Weak spots</Eyebrow>
            <WeakSpotsPanel spots={weakSpots} />
          </section>
        </div>
      </div>
    </div>
  );
}
