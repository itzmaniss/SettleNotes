"use client";

import { useState, useTransition } from "react";
import { setTaskDone } from "@/app/(dashboard)/actions";
import { Check } from "@/components/settle";

type TaskCheckProps = {
  taskId: string;
  done: boolean;
  title: string;
};

// The tick on a This week row. Optimistic: flips instantly, rolls back and
// announces the failure through the polite live region if the action fails.
export function TaskCheck({ taskId, done, title }: TaskCheckProps) {
  const [optimisticDone, setOptimisticDone] = useState(done);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function toggle() {
    const next = !optimisticDone;
    setOptimisticDone(next);
    setError("");
    startTransition(async () => {
      const result = await setTaskDone(taskId, next);
      if (!result.ok) {
        setOptimisticDone(!next);
        setError(result.error);
      }
    });
  }

  return (
    <span className="shrink-0">
      <Check
        checked={optimisticDone}
        onCheckedChange={toggle}
        disabled={pending}
        label={`Mark ${title} as ${optimisticDone ? "to do" : "done"}`}
      />
      <span role="status" aria-live="polite" className="sr-only">
        {error}
      </span>
    </span>
  );
}
