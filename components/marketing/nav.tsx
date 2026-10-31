import Link from "next/link";
import { BotButton } from "./bot-button";
import { botLink } from "./links";

export function Nav() {
  return (
    <header className="mx-auto mt-4 w-full max-w-6xl px-4 sm:px-6">
      <div className="flex items-center justify-between gap-3 rounded-full border-2 border-border bg-card py-2 pl-5 pr-2">
        <Link
          href="/"
          className="font-display text-xl font-extrabold tracking-tight"
        >
          settle
        </Link>
        <nav
          aria-label="Site"
          className="hidden items-center gap-6 text-sm font-medium md:flex"
        >
          <a
            href="#how"
            className="rounded-full px-1 py-2 underline-offset-4 hover:underline"
          >
            How it works
          </a>
          <a
            href="#pricing"
            className="rounded-full px-1 py-2 underline-offset-4 hover:underline"
          >
            Pricing
          </a>
        </nav>
        <Link
          href="/login"
          className="text-sm font-medium whitespace-nowrap underline-offset-4 hover:underline"
        >
          Log in
        </Link>
        <BotButton href={botLink()} tone="accent" className="text-sm">
          Open in Telegram
        </BotButton>
      </div>
    </header>
  );
}
