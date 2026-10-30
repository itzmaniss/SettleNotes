"use client";

// Route-level error boundary. The digest goes to server logs; the student
// just gets a calm retry.
export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="font-display text-xl font-bold">Something broke on this page.</p>
      <p className="mt-2 text-sm text-muted-foreground">Your work is safe. Give it another go.</p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex min-h-[44px] items-center rounded-full border-2 border-border bg-accent px-5 font-semibold text-accent-foreground shadow-[3px_3px_0_0_var(--foreground)] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
      >
        Try again
      </button>
    </div>
  );
}
