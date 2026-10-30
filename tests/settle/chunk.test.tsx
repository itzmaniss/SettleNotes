import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Chunk } from "@/components/settle";

function render(tone?: "card" | "accent" | "pop" | "ink", className?: string) {
  return renderToStaticMarkup(
    <Chunk tone={tone} className={className}>
      hello
    </Chunk>
  );
}

describe("Chunk", () => {
  test("default tone is card", () => {
    expect(renderToStaticMarkup(<Chunk>x</Chunk>)).toContain("bg-card");
  });

  test("card tone", () => {
    expect(render("card")).toContain("bg-card");
  });

  test("accent tone wins over the card default", () => {
    const html = render("accent");
    expect(html).toContain("bg-accent");
    expect(html).toContain("text-accent-foreground");
    expect(html).not.toContain("bg-card");
  });

  test("pop tone wins over the card default", () => {
    const html = render("pop");
    expect(html).toContain("bg-pop-soft");
    expect(html).not.toContain("bg-card");
    expect(html).not.toContain("bg-accent");
  });

  test("ink tone is foreground background with background text", () => {
    const html = render("ink");
    expect(html).toContain("bg-foreground");
    expect(html).toContain("text-background");
    expect(html).not.toContain("bg-card");
  });

  test("always carries the 2px border and the hard shadow", () => {
    const html = render("accent");
    expect(html).toContain("border-2");
    expect(html).toContain("border-border");
    expect(html).toContain("rounded-[var(--radius)]");
    expect(html).toContain("shadow-[4px_4px_0_0_var(--foreground)]");
  });

  test("merges className without losing the tone", () => {
    const html = render("accent", "p-6 -rotate-2");
    expect(html).toContain("p-6");
    expect(html).toContain("-rotate-2");
    expect(html).toContain("bg-accent");
  });
});
