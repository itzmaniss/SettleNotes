"use client";

import { useOptimistic, useState, useTransition } from "react";
import { toggleChecklistItem } from "@/app/(dashboard)/actions";
import { Check } from "@/components/settle";
import { toPlainMath } from "@/lib/text/plain-math";
import type { ChecklistItem } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./eyebrow";

const CATEGORY_ORDER = ["deliverable", "submission_rule", "rubric"] as const;
const CATEGORY_LABELS: Record<(typeof CATEGORY_ORDER)[number], string> = {
  deliverable: "Deliverables",
  submission_rule: "Submission rules",
  rubric: "Rubric",
};

type TogglePatch = { id: string; done: boolean };

type ChecklistViewProps = {
  taskId: string;
  starterId: string;
  items: ChecklistItem[];
};

// Grouped by category, each tick optimistic through useOptimistic. A failed
// save rolls the tick back and is announced through the live region.
export function ChecklistView({ taskId, starterId, items }: ChecklistViewProps) {
  const [optimisticItems, applyOptimistic] = useOptimistic(
    items,
    (state: ChecklistItem[], patch: TogglePatch) =>
      state.map((item) => (item.id === patch.id ? { ...item, done: patch.done } : item)),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function setDone(item: ChecklistItem, done: boolean) {
    setError("");
    startTransition(async () => {
      applyOptimistic({ id: item.id, done });
      const result = await toggleChecklistItem(taskId, starterId, item.id, done);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div>
      <Eyebrow as="h2">Checklist</Eyebrow>
      {CATEGORY_ORDER.map((category) => {
        const group = optimisticItems.filter((item) => item.category === category);
        if (group.length === 0) return null;
        return (
          <div key={category} className="mt-5 first:mt-3">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {CATEGORY_LABELS[category]}
            </p>
            <ul className="mt-2 space-y-1">
              {group.map((item) => (
                <li key={item.id} className="flex items-start gap-3 py-1.5">
                  <Check
                    checked={item.done}
                    onCheckedChange={(checked) => setDone(item, checked === true)}
                    disabled={pending}
                    label={`Tick: ${item.text}`}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm leading-relaxed", item.done && "text-muted-foreground line-through")}>
                      {/* Checklist text renders raw (no KaTeX here), so any
                          LaTeX that slipped through comes out as plain text. */}
                      {toPlainMath(item.text)}
                    </p>
                    {item.page != null && (
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">p.{item.page}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p role="status" aria-live="polite" className="sr-only">
        {error}
      </p>
    </div>
  );
}
