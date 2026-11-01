import { Chunk, ChunkButton, Sticker } from "@/components/settle";
import { usageLine } from "@/lib/dashboard/plan";
import {
  CLOSED_NOTE,
  MANAGE_BUTTON_LABEL,
  PAYNOW_LABEL,
  PREFER_TELEGRAM_LINE,
  STARS_ACTIVE_LINE,
  TEST_MODE_STICKER,
  type BillingPageView,
} from "@/lib/billing/view";

// Presentational half of /billing: pure markup over the view-model, with the
// two server actions handed in as form actions so tests can render this
// without Next. Mobile first: one column, chunk pills are 44px tall.
export type BillingPanelProps = {
  view: BillingPageView;
  startCheckout: (formData: FormData) => void | Promise<void>;
  openPortal: (formData: FormData) => void | Promise<void>;
};

export function BillingPanel({ view, startCheckout, openPortal }: BillingPanelProps) {
  const onFree = view.current.planName === "Free";
  return (
    <div className="pt-4">
      <header>
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Plan and billing</h1>
        {view.testMode && (
          <div className="mt-3">
            <Sticker tone="pop" tilt={2}>
              {TEST_MODE_STICKER}
            </Sticker>
          </div>
        )}
      </header>

      {view.banner !== null && (
        <Chunk
          tone={view.banner.tone === "error" ? "card" : "accent"}
          role="status"
          className="mt-6 p-4 text-sm font-medium"
        >
          {view.banner.message}
        </Chunk>
      )}

      <section aria-labelledby="current-plan-heading" className="mt-8">
        <p
          id="current-plan-heading"
          className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
        >
          Current plan
        </p>
        <Chunk className="mt-3 p-5">
          <p className="font-display text-2xl font-extrabold">{view.current.planName}</p>
          {view.current.until !== null && (
            <p className="mt-1 text-sm text-muted-foreground">
              Pro until {view.current.until}
            </p>
          )}
          <ul className="mt-4 space-y-2 text-sm">
            {view.current.usage.rows.map((row) => (
              <li key={row.feature} className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{row.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {usageLine(row)}
                </span>
              </li>
            ))}
          </ul>
        </Chunk>
      </section>

      {view.showPortal ? (
        <section aria-labelledby="manage-heading" className="mt-8">
          <p
            id="manage-heading"
            className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
          >
            Manage
          </p>
          <form action={openPortal} className="mt-3">
            <ChunkButton tone="ink" type="submit" className="w-full justify-center">
              {MANAGE_BUTTON_LABEL}
            </ChunkButton>
          </form>
          {view.portalNote !== null && (
            <p className="mt-2 text-sm text-muted-foreground">{view.portalNote}</p>
          )}
        </section>
      ) : view.starsActive ? (
        <p className="mt-8 text-sm text-muted-foreground">{STARS_ACTIVE_LINE}</p>
      ) : null}

      {view.open ? (
        onFree && !view.showPortal ? (
          <section aria-labelledby="plans-heading" className="mt-8">
            <p
              id="plans-heading"
              className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
            >
              Go Pro
            </p>
            <div className="mt-3 space-y-4">
              {view.options.map((option) => (
                <Chunk key={option.interval} tone="card" className="p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-display text-lg font-bold">{option.label}</p>
                    <p className="font-display text-2xl font-extrabold">{option.price}</p>
                  </div>
                  {option.note !== null && (
                    <p className="mt-1 text-sm text-muted-foreground">{option.note}</p>
                  )}
                  <form action={startCheckout} className="mt-4">
                    <input type="hidden" name="interval" value={option.interval} />
                    <ChunkButton tone="ink" type="submit" className="w-full justify-center">
                      Choose {option.label}
                    </ChunkButton>
                  </form>
                </Chunk>
              ))}
              {view.paynowAvailable && (
                <Chunk tone="card" className="p-5">
                  <form action={startCheckout}>
                    <input type="hidden" name="interval" value="paynow" />
                    <ChunkButton tone="card" type="submit" className="w-full justify-center">
                      {PAYNOW_LABEL}
                    </ChunkButton>
                  </form>
                </Chunk>
              )}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">{PREFER_TELEGRAM_LINE}</p>
          </section>
        ) : null
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">{CLOSED_NOTE}</p>
      )}
    </div>
  );
}
