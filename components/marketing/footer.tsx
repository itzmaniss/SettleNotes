import { botLink } from "./links";
import { LegalLinks } from "@/components/legal/legal-links";

export function Footer() {
  const botHref = botLink();
  return (
    <footer className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-10 font-mono text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6">
      <p>
        <span className="font-display text-sm font-extrabold text-foreground">
          settle
        </span>{" "}
        · made in Singapore
      </p>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-6">
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
