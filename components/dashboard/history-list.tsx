import { describeTaskEvent, eventWording } from "@/lib/dashboard/history";
import { formatSgtDateTime } from "@/lib/dashboard/format";
import type { TaskEventRow } from "@/lib/db/types";
import { Eyebrow } from "./eyebrow";

// task_events newest first, with the quoted Singlish evidence that justified
// each change. The change text comes from before/after and stays silent when
// the stored JSON does not carry a diff we recognise.
export function HistoryList({ events }: { events: TaskEventRow[] }) {
  if (events.length === 0) return null;
  return (
    <section aria-labelledby="history-heading" className="mt-10">
      <Eyebrow as="h2" id="history-heading">
        History
      </Eyebrow>
      <ol className="mt-3 space-y-4">
        {events.map((event) => {
          const summary = describeTaskEvent(event);
          const evidence = (event.evidence ?? "").trim();
          return (
            <li key={event.id} className="border-b border-dashed border-border/30 pb-4 last:border-none last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold">{eventWording(event.action)}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {formatSgtDateTime(event.created_at)}
                </span>
              </div>
              {summary.change != null && (
                <p className="mt-1 text-sm text-muted-foreground">{summary.change}</p>
              )}
              {evidence !== "" && (
                <p className="mt-1 font-mono text-xs italic leading-relaxed text-muted-foreground">
                  &ldquo;{evidence}&rdquo;
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
