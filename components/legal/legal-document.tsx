import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import type { LegalDocument } from "@/lib/legal/content";
import type { LegalBlock, LegalSpan } from "@/lib/legal/markdown";

// Inline spans of one paragraph line. A counsel marker becomes the visible
// lilac note box: a span styled as a block, so it stays valid HTML inside a
// paragraph and still reads as its own card. React escapes all text.
function SpanView({ span, inList }: { span: LegalSpan; inList: boolean }) {
  if (span.kind === "text") return <>{span.text}</>;
  if (span.kind === "bold") return <strong>{span.text}</strong>;
  if (span.kind === "marker") {
    return (
      <span className="my-4 block border-2 border-border bg-pop-soft px-4 py-3">
        <span className="mb-1 block font-mono text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Waiting for review
        </span>
        {span.text}
      </span>
    );
  }
  // Link. External https targets carry the rel from the span; relative and
  // mailto targets need none. Inside a list item the link is a flex row with
  // a 44px minimum height so it stays a tap target; in running prose that
  // would break the line flow, so there it is a plain underlined anchor.
  const anchorClass = inList
    ? "inline-flex min-h-[44px] items-center text-foreground underline underline-offset-4"
    : "text-foreground underline underline-offset-4";
  return (
    <a href={span.href} rel={span.rel ?? undefined} className={anchorClass}>
      {span.spans.map((inner, at) => (
        <SpanView key={at} span={inner} inList={inList} />
      ))}
    </a>
  );
}

function SpansView({ spans, inList }: { spans: LegalSpan[]; inList: boolean }) {
  return (
    <>
      {spans.map((span, at) => (
        <SpanView key={at} span={span} inList={inList} />
      ))}
    </>
  );
}

// One parsed block: h1 arrives separately as the page title, so only h2, p
// and ul are rendered here.
function BlockView({ block }: { block: LegalBlock }) {
  if (block.kind === "h2") {
    return (
      <h2 className="mt-8 font-display text-xl font-bold sm:text-2xl">
        <SpansView spans={block.spans} inList={false} />
      </h2>
    );
  }
  if (block.kind === "ul") {
    return (
      <ul className="mt-4 list-disc space-y-1 pl-6">
        {block.items.map((item, at) => (
          <li key={at} className="text-base leading-relaxed">
            <SpansView spans={item.spans} inList={true} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="mt-4 text-base leading-relaxed break-words">
      <SpansView spans={block.spans} inList={false} />
    </p>
  );
}

// The whole legal page shell for one loaded document: the site header and
// footer every public page shares, around the 65ch readable article. Server
// safe: no client hooks, no event handlers, nothing but markup.
export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8">
        <article className="max-w-[65ch]">
          <h1 className="font-display text-3xl font-bold sm:text-4xl">{doc.title}</h1>
          {doc.blocks
            .filter((block) => block.kind !== "h1")
            .map((block, at) => (
              <BlockView key={at} block={block} />
            ))}
        </article>
      </main>
      <Footer />
    </div>
  );
}
