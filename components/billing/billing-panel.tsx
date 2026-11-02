import { Chunk, ChunkButton, Sticker } from "@/components/settle";
import { usageLine } from "@/lib/dashboard/plan";
import {
  PURCHASE_CONFIRM_BODY,
  PURCHASE_CONFIRM_TITLE,
  PURCHASE_CONFIRM_WEB_LABEL,
} from "@/lib/billing/purchase-consent-copy";
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
// without Next. Mobile first: one column, chunk pills are 44px tall. The
// purchase confirm block (title, body, one checkbox) sits above the monthly
// and yearly buttons inside a single form, so every paid checkout, PayNow
// included, submits the confirm field the server action requires.
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
            <Chunk tone="card" className="mt-3 p-5">
              <p className="font-display text-lg font-bold">{PURCHASE_CONFIRM_TITLE}</p>
              <p className="mt-1 text-sm text-muted-foreground">{PURCHASE_CONFIRM_BODY}</p>
              <form action={startCheckout} className="mt-4">
                <label className="flex min-h-[44px] items-center gap-3 rounded-2xl border border-border px-3 py-2">
                  <input
                    type="checkbox"
                    name="confirm"
                    value="on"
                    required
                    className="size-5 shrink-0 accent-foreground"
                  />
                  <span className="text-sm font-medium">{PURCHASE_CONFIRM_WEB_LABEL}</span>
                </label>
                <div className="mt-4 space-y-4">
                  {view.options.map((option) => (
                    <div key={option.interval}>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="font-display text-lg font-bold">{option.label}</p>
                        <p className="font-display text-2xl font-extrabold">{option.price}</p>
                      </div>
                      {option.note !== null && (
                        <p className="mt-1 text-sm text-muted-foreground">{option.note}</p>
                      )}
                      <ChunkButton
                        tone="ink"
                        type="submit"
                        name="interval"
                        value={option.interval}
                        className="mt-3 w-full justify-center"
                      >
                        Choose {option.label}
                      </ChunkButton>
                    </div>
                  ))}
                  {view.paynowAvailable && (
                    <ChunkButton
                      tone="card"
                      type="submit"
                      name="interval"
                      value="paynow"
                      className="w-full justify-center"
                    >
                      {PAYNOW_LABEL}
                    </ChunkButton>
                  )}
                </div>
              </form>
            </Chunk>
            <p className="mt-4 text-sm text-muted-foreground">{PREFER_TELEGRAM_LINE}</p>
          </section>
        ) : null
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">{CLOSED_NOTE}</p>
      )}
    </div>
  );
}
