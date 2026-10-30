"use client";

import { useState, useTransition } from "react";
import { setTaskDone } from "@/app/(dashboard)/actions";
import { ChunkButton } from "@/components/settle";

// Mark done toggle on the task page, as a chunky button instead of a box.
export function TaskDoneToggle({ taskId, done }: { taskId: string; done: boolean }) {
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
    <div>
      <ChunkButton
        tone={optimisticDone ? "card" : "accent"}
        disabled={pending}
        onClick={toggle}
        aria-pressed={optimisticDone}
      >
        {optimisticDone ? "Mark as to do" : "Mark as done"}
      </ChunkButton>
      <p role="status" aria-live="polite" className="sr-only">
        {error}
      </p>
    </div>
  );
}
