import { Chunk, ChunkButton, Sticker } from "@/components/settle";
import { usageLine, type LockState, type PlanView } from "@/lib/dashboard/plan";

// The usage half of the upgrade panel from the brief's T19: what the student
// used this month and when it resets. With Stripe configured and billing on
// the button becomes a link to /billing (T21); otherwise it stays disabled.
// No prices here: selling happens on /billing and the pricing page.
export function PlanCard({
  view,
  billingOpen = false,
}: {
  view: PlanView;
  billingOpen?: boolean;
}) {
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
        {billingOpen ? (
          <ChunkButton tone="ink" render={<a href="/billing" />}>
            See plans
          </ChunkButton>
        ) : (
          <ChunkButton disabled>Coming soon</ChunkButton>
        )}
      </div>
    </Chunk>
  );
}

// Direction C banner above the Plan card for a Free student who ran into a
// monthly limit. States the fact and the reset date, points to /billing when
// checkout is open. No prices and no Stars numbers here or anywhere in it.
export function LockBanner({
  state,
  billingOpen = false,
}: {
  state: LockState;
  billingOpen?: boolean;
}) {
  return (
    <Chunk tone="pop" className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Sticker tone="ink" tilt={-2}>
            limit reached
          </Sticker>
          <p className="mt-3 max-w-xs text-base leading-relaxed">{state.sentence}</p>
        </div>
        {billingOpen ? (
          <ChunkButton tone="ink" render={<a href="/billing" />} className="shrink-0 self-start">
            See plans
          </ChunkButton>
        ) : null}
      </div>
    </Chunk>
  );
}
