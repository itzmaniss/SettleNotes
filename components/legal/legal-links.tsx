import { LEGAL_LABELS, LEGAL_PATHS, type LegalPageKey } from "@/lib/legal/paths";

// Footer style row of legal links, Direction C: Geist Mono small caps feel,
// wraps on a 390px screen, and every link is a tap target of at least 44px
// via the vertical padding. Server safe: no client hooks, no event handlers.
export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={`flex flex-wrap items-center gap-x-5 gap-y-1 ${className}`}>
      {(Object.keys(LEGAL_PATHS) as LegalPageKey[]).map((key) => (
        <a
          key={key}
          href={LEGAL_PATHS[key]}
          className="inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-widest text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {LEGAL_LABELS[key]}
        </a>
      ))}
    </nav>
  );
}
