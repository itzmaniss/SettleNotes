import { Chunk, ChunkButton } from "@/components/settle";
import { usageLine, type PlanView } from "@/lib/dashboard/plan";

// The usage half of the upgrade panel from the brief's T19: what the student
// used this month and when it resets. Checkout does not exist yet (T21/T22),
// so the Pro button is a real disabled button reading Coming soon. No prices
// here: selling happens on the web pricing page, never inside the app.
export function PlanCard({ view }: { view: PlanView }) {
  return (
    <Chunk className="p-5">
      <p className="font-display text-2xl font-extrabold">{view.planName}</p>
      <ul className="mt-4 space-y-3">
        {view.rows.map((row) => (
          <li
            key={row.feature}
            className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
          >
            <span className="font-medium">{row.label}</span>
            <span className="font-mono text-[11px] leading-snug text-muted-foreground sm:shrink-0 sm:text-xs">
              {usageLine(row)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        Resets {view.resetsOn}
      </p>
      <div className="mt-5">
        <ChunkButton disabled>Coming soon</ChunkButton>
      </div>
    </Chunk>
  );
}
