import Link from "next/link";
import { Logo } from "@/components/settle";
import { BotButton } from "./bot-button";
import { botLink } from "./links";

// hideLogin drops the Log in link on /login itself, where it would just
// relink the page you are on. Every other page keeps the landing header:
// brand, section links, Log in, bot button.
export function Nav({ hideLogin = false }: { hideLogin?: boolean }) {
  return (
    <header className="mx-auto mt-4 w-full max-w-6xl px-4 sm:px-6">
      <div className="flex items-center justify-between gap-3 rounded-full border-2 border-border bg-card py-2 pl-5 pr-2">
        <Link
          href="/"
          className="inline-flex items-center gap-2 font-display text-xl font-extrabold tracking-tight"
        >
          <Logo size={26} />
          settle
        </Link>
        {/* Root relative anchors so How it works and Pricing still scroll on
            the landing page and land there from every other page too. */}
        <nav
          aria-label="Site"
          className="hidden items-center gap-6 text-sm font-medium md:flex"
        >
          <Link
            href="/#how"
            className="rounded-full px-1 py-2 underline-offset-4 hover:underline"
          >
            How it works
          </Link>
          <Link
            href="/guides"
            className="rounded-full px-1 py-2 underline-offset-4 hover:underline"
          >
            Guides
          </Link>
          <Link
            href="/#pricing"
            className="rounded-full px-1 py-2 underline-offset-4 hover:underline"
          >
            Pricing
          </Link>
        </nav>
        {/* Log in belongs beside the primary action, not floating mid gap. */}
        <div className="flex items-center gap-4">
          {hideLogin ? null : (
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center text-sm font-medium whitespace-nowrap underline-offset-4 hover:underline"
            >
              Log in
            </Link>
          )}
          <BotButton href={botLink()} tone="accent" className="text-sm">
            Open in Telegram
          </BotButton>
        </div>
      </div>
    </header>
  );
}
