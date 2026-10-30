import { MixedMath } from "./mixed-math";
import { Eyebrow } from "./eyebrow";

// Practice questions with reveal-answer disclosures. Native <details>, so it
// works with JavaScript off and the summary is a 44px tap target. Copy is
// sentence text with $-wrapped maths, never raw LaTeX.
export function PracticeReveals({
  items,
  heading = "Practice",
}: {
  items: Array<{ question: string; answer: string }>;
  heading?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <Eyebrow as="h3">{heading}</Eyebrow>
      <ul className="mt-2 space-y-2">
        {items.map((item, index) => (
          <li key={index}>
            <details className="rounded-[var(--radius)] border-2 border-border bg-card shadow-[3px_3px_0_0_var(--foreground)]">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-3 px-4 py-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                <span aria-hidden="true" className="shrink-0 font-mono text-xs text-muted-foreground">
                  {index + 1}.
                </span>
                <MixedMath text={item.question} />
              </summary>
              <div className="border-t-2 border-border px-4 py-3 text-sm leading-relaxed">
                <MixedMath text={item.answer} />
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
