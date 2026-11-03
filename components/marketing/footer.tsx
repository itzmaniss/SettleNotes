import Link from "next/link";
import { Logo } from "@/components/settle";
import { botLink } from "./links";
import { LegalLinks } from "@/components/legal/legal-links";

export function Footer() {
  const botHref = botLink();
  return (
    <footer className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-10 font-mono text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6">
      <p>
        <span className="inline-flex items-center gap-1.5 align-middle">
          <Logo size={20} />
          <span className="font-display text-sm font-extrabold text-foreground">
            settle
          </span>
        </span>{" "}
        · made in Singapore
      </p>
      {/* Links sit a step above the brand line: 14px so the legal links can
          meet the 14px accessibility floor while the whole row still matches. */}
      <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-6">
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5">
          <a
            href="#how"
            className="inline-flex items-center py-3 underline-offset-4 hover:underline sm:py-0"
          >
            How it works
          </a>
          <a
            href="#pricing"
            className="inline-flex items-center py-3 underline-offset-4 hover:underline sm:py-0"
          >
            Pricing
          </a>
          <Link
            href="/guides"
            className="inline-flex items-center py-3 underline-offset-4 hover:underline sm:py-0"
          >
            Guides
          </Link>
          <Link
            href="/faq"
            className="inline-flex items-center py-3 underline-offset-4 hover:underline sm:py-0"
          >
            FAQ
          </Link>
          {botHref !== null && (
            <a
              href={botHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center py-3 underline-offset-4 hover:underline sm:py-0"
            >
              Open in Telegram
            </a>
          )}
        </nav>
        <LegalLinks />
      </div>
    </footer>
  );
}
