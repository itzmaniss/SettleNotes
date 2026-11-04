import Link from "next/link";
import { Chunk, ChunkButton } from "@/components/settle";
import { ACCOUNT_NAME_FALLBACK } from "@/lib/account/web-copy";
import type { AccountPageView } from "@/lib/account/view";
import {
  ACCOUNT_DELETE_BODY,
  ACCOUNT_DELETE_BUTTON_LABEL,
  ACCOUNT_DELETE_CHECKBOX_LABEL,
  ACCOUNT_DELETE_HEADING,
  ACCOUNT_DELETE_WORD_LABEL,
  ACCOUNT_DELETE_WORD_PLACEHOLDER,
  ACCOUNT_DOWNLOAD_BODY,
  ACCOUNT_DOWNLOAD_BUTTON_LABEL,
  ACCOUNT_DOWNLOAD_HEADING,
  ACCOUNT_LOGOUT_NOTE,
  ACCOUNT_PLAN_LABEL,
  ACCOUNT_PRIVACY_LINE,
  ACCOUNT_PRIVACY_LINK_LABEL,
  ACCOUNT_TITLE,
  ACCOUNT_YOU_HEADING,
  LOG_OUT_BUTTON_LABEL,
} from "@/lib/account/web-copy";

// Presentational half of /account, in the same style as the billing panel:
// pure markup over the view model, with the two server actions handed in as
// form actions so tests can render this without Next. Mobile first, one
// column, chunk pills are 44px tall.
export type AccountPanelProps = {
  view: AccountPageView;
  logOut: (formData: FormData) => void | Promise<void>;
  deleteAccount: (formData: FormData) => void | Promise<void>;
};

export function AccountPanel({ view, logOut, deleteAccount }: AccountPanelProps) {
  return (
    <div className="pt-4">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">{ACCOUNT_TITLE}</h1>

      {view.banner !== null && (
        <Chunk
          tone={view.banner.tone}
          role={view.banner.role}
          className="mt-6 p-4 text-sm font-medium"
        >
          {view.banner.message}
          {view.banner.linkHref !== null && (
            <>
              {" "}
              <Link
                href={view.banner.linkHref}
                className="font-semibold underline underline-offset-4"
              >
                {view.banner.linkLabel}
              </Link>
            </>
          )}
        </Chunk>
      )}

      <section aria-labelledby="you-heading" className="mt-8">
        <p
          id="you-heading"
          className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
        >
          {ACCOUNT_YOU_HEADING}
        </p>
        <Chunk className="mt-3 p-5">
          <p className="font-display text-2xl font-extrabold">
            {view.firstName ?? ACCOUNT_NAME_FALLBACK}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {ACCOUNT_PLAN_LABEL}: {view.planName}
          </p>
          <form action={logOut} className="mt-4">
            <ChunkButton tone="ink" type="submit" className="w-full justify-center">
              {LOG_OUT_BUTTON_LABEL}
            </ChunkButton>
          </form>
          <p className="mt-2 text-sm text-muted-foreground">{ACCOUNT_LOGOUT_NOTE}</p>
        </Chunk>
      </section>

      <section aria-labelledby="download-heading" className="mt-8">
        <p
          id="download-heading"
          className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
        >
          {ACCOUNT_DOWNLOAD_HEADING}
        </p>
        <Chunk className="mt-3 p-5">
          <p className="text-sm leading-relaxed">{ACCOUNT_DOWNLOAD_BODY}</p>
          <ChunkButton
            tone="accent"
            className="mt-4 w-full justify-center"
            render={<a href="/account/export" />}
          >
            {ACCOUNT_DOWNLOAD_BUTTON_LABEL}
          </ChunkButton>
        </Chunk>
      </section>

      <section aria-labelledby="delete-heading" className="mt-8">
        <p
          id="delete-heading"
          className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
        >
          {ACCOUNT_DELETE_HEADING}
        </p>
        <Chunk tone="card" className="mt-3 p-5">
          <p className="text-sm leading-relaxed">{ACCOUNT_DELETE_BODY}</p>
          <form action={deleteAccount} className="mt-4">
            <label className="mt-4 flex min-h-[44px] flex-col justify-center gap-1">
              <span className="text-sm font-medium">{ACCOUNT_DELETE_WORD_LABEL}</span>
              <input
                type="text"
                name="confirm_word"
                required
                autoComplete="off"
                placeholder={ACCOUNT_DELETE_WORD_PLACEHOLDER}
                className="min-h-[44px] rounded-2xl border border-border bg-background px-3 text-sm outline-none focus-visible:border-ring"
              />
            </label>
            <label className="mt-4 flex min-h-[44px] items-center gap-3 rounded-2xl border border-border px-3 py-2">
              <input
                type="checkbox"
                name="confirm_box"
                value="on"
                required
                className="size-5 shrink-0 accent-foreground"
              />
              <span className="text-sm font-medium">{ACCOUNT_DELETE_CHECKBOX_LABEL}</span>
            </label>
            <ChunkButton tone="ink" type="submit" className="mt-4 w-full justify-center">
              {ACCOUNT_DELETE_BUTTON_LABEL}
            </ChunkButton>
          </form>
        </Chunk>
      </section>

      <p className="mt-8 text-sm text-muted-foreground">
        {ACCOUNT_PRIVACY_LINE}{" "}
        <Link href="/privacy" className="font-semibold underline underline-offset-4">
          {ACCOUNT_PRIVACY_LINK_LABEL}
        </Link>
      </p>
    </div>
  );
}
