import Link from "next/link";

import { LegalLinks } from "@/components/legal/legal-links";

// Slim dashboard footer: the public site pages one tap away from every
// dashboard screen, since the pill row only covers the app itself. 14px
// text, every link a 44px tap target, and a wrapping row so six links fold
// onto two lines on a 360px screen instead of overflowing.
export function DashboardFooter() {
  return (
    <footer className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t-2 border-border pt-2 text-sm text-muted-foreground">
        <Link
          href="/"
          className="inline-flex min-h-[44px] items-center whitespace-nowrap underline-offset-4 hover:text-foreground hover:underline"
        >
          Home page
        </Link>
        <Link
          href="/guides"
          className="inline-flex min-h-[44px] items-center whitespace-nowrap underline-offset-4 hover:text-foreground hover:underline"
        >
          Guides
        </Link>
        <Link
          href="/faq"
          className="inline-flex min-h-[44px] items-center whitespace-nowrap underline-offset-4 hover:text-foreground hover:underline"
        >
          Help
        </Link>
        <LegalLinks />
      </div>
    </footer>
  );
}
