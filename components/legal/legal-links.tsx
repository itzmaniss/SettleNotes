import { LEGAL_LABELS, LEGAL_PATHS, type LegalPageKey } from "@/lib/legal/paths";

// Row of legal links matching the other footer links: sentence case, same
// mono family, 14px, muted. Keeps min-h-[44px] so every link stays a tap
// target on a 390px screen. Server safe: no client hooks, no event handlers.
export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={`flex flex-wrap items-center gap-x-5 gap-y-1 ${className}`}>
      {(Object.keys(LEGAL_PATHS) as LegalPageKey[]).map((key) => (
        <a
          key={key}
          href={LEGAL_PATHS[key]}
          className="inline-flex min-h-[44px] items-center font-mono text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {LEGAL_LABELS[key]}
        </a>
      ))}
    </nav>
  );
}
