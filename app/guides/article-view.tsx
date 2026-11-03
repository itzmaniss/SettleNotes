import Link from "next/link";

import { BotButton } from "@/components/marketing/bot-button";
import { botLink } from "@/components/marketing/links";
import type { GuideBlock, GuideSpan } from "@/lib/guides/markdown";

// Inline spans of one guide paragraph or list item, styled like the legal
// document renderer: bold stays bold, links are underlined anchors, and a
// refused target has already become plain text at parse time. React escapes
// all text. Inside a list item the link keeps a 44px minimum height so it
// stays a tap target; in running prose that would break the line flow.
function SpanView({ span, inList }: { span: GuideSpan; inList: boolean }) {
  if (span.kind === "text") return <>{span.text}</>;
  if (span.kind === "bold") return <strong>{span.text}</strong>;
  if (span.kind === "marker") return <>{span.text}</>;
  const anchorClass = inList
    ? "inline-flex min-h-[44px] items-center text-foreground underline underline-offset-4"
    : "text-foreground underline underline-offset-4";
  if (span.external) {
    return (
      <a href={span.href} rel={span.rel ?? undefined} className={anchorClass}>
        {span.spans.map((inner, at) => (
          <SpanView key={at} span={inner} inList={inList} />
        ))}
      </a>
    );
  }
  return (
    <a href={span.href} className={anchorClass}>
      {span.spans.map((inner, at) => (
        <SpanView key={at} span={inner} inList={inList} />
      ))}
    </a>
  );
}

function SpansView({ spans, inList }: { spans: GuideSpan[]; inList: boolean }) {
  return (
    <>
      {spans.map((span, at) => (
        <SpanView key={at} span={span} inList={inList} />
      ))}
    </>
  );
}

// One parsed body block: h2, paragraph, bullet list or numbered list. The
// loader never hands over an h1, so the article keeps exactly one.
export function GuideBlockView({ block }: { block: GuideBlock }) {
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
  if (block.kind === "ol") {
    return (
      <ol className="mt-4 list-decimal space-y-1 pl-6">
        {block.items.map((item, at) => (
          <li key={at} className="text-base leading-relaxed">
            <SpansView spans={item.spans} inList={true} />
          </li>
        ))}
      </ol>
    );
  }
  if (block.kind === "p") {
    return (
      <p className="mt-4 text-base leading-relaxed break-words">
        <SpansView spans={block.spans} inList={false} />
      </p>
    );
  }
  return null;
}

// The same call to action the landing hero uses: the BotButton on the bot
// link, degrading to a disabled button when no username is configured. It
// replaces the trailing [Open the Settle bot on Telegram](/#start) line the
// loader stripped from every document.
export function GuideCtaButton() {
  return (
    <div className="mt-10">
      <BotButton href={botLink()} tone="accent">
        Open the Settle bot on Telegram
      </BotButton>
    </div>
  );
}

// The breadcrumb row under the header: Home and the guides index are real
// links, the current article is plain words.
export function GuideBreadcrumb({ title }: { title: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-x-1 font-mono text-sm text-muted-foreground"
    >
      <Link
        href="/"
        className="inline-flex min-h-[44px] items-center underline-offset-4 hover:text-foreground hover:underline"
      >
        Home
      </Link>
      <span aria-hidden="true">/</span>
      <Link
        href="/guides"
        className="inline-flex min-h-[44px] items-center underline-offset-4 hover:text-foreground hover:underline"
      >
        Study guides
      </Link>
      <span aria-hidden="true">/</span>
      <span className="text-foreground">{title}</span>
    </nav>
  );
}
