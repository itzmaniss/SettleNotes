import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MixedMath, splitMathSegments } from "@/components/dashboard/mixed-math";

function render(text: string): string {
  return renderToStaticMarkup(<MixedMath text={text} />);
}

describe("splitMathSegments", () => {
  test("no dollars is a single text run", () => {
    expect(splitMathSegments("Find the critical points of x^3 - 3x.")).toEqual([
      { kind: "text", value: "Find the critical points of x^3 - 3x." },
    ]);
  });

  test("inline math splits text, math, text", () => {
    expect(splitMathSegments("Differentiate $(2x-7)^6$.")).toEqual([
      { kind: "text", value: "Differentiate " },
      { kind: "inline", value: "(2x-7)^6" },
      { kind: "text", value: "." },
    ]);
  });

  test("double dollars are display math", () => {
    expect(splitMathSegments("So $$x = 3$$ as claimed.")).toEqual([
      { kind: "text", value: "So " },
      { kind: "display", value: "x = 3" },
      { kind: "text", value: " as claimed." },
    ]);
  });

  test("an unmatched dollar stays plain text", () => {
    expect(splitMathSegments("that costs $5 today")).toEqual([
      { kind: "text", value: "that costs $5 today" },
    ]);
    expect(splitMathSegments("$5")).toEqual([{ kind: "text", value: "$5" }]);
  });

  test("an escaped dollar is a literal dollar", () => {
    expect(splitMathSegments("pay \\$5 for $x$")).toEqual([
      { kind: "text", value: "pay $5 for " },
      { kind: "inline", value: "x" },
    ]);
  });

  test("empty string gives no segments", () => {
    expect(splitMathSegments("")).toEqual([]);
  });
});

describe("MixedMath rendering", () => {
  test("plain sentence keeps its spaces and never reaches katex", () => {
    const html = render("Find the critical points of x^3 - 3x.");
    expect(html).toContain("Find the critical points of x^3 - 3x.");
    expect(html).not.toContain("katex");
  });

  test("inline math renders a katex span between intact text runs", () => {
    const html = render("The answer is $12(2x-7)^5$.");
    expect(html).toContain("The answer is ");
    expect(html).toContain("katex");
    expect(html).toContain("<span>.</span>");
  });

  test("display math renders katex-display inside a block wrapper", () => {
    const html = render("So $$x = 3$$ as claimed.");
    expect(html).toContain("katex-display");
    expect(html).toContain(" as claimed.");
  });

  test("script tags in text are escaped", () => {
    const html = render("<script>alert(1)</script> is safe");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; is safe");
  });

  test("bad latex does not throw: throwOnError false shows the source", () => {
    const html = render("bad $\\notacommandhere{x}$ here");
    expect(html).toContain("katex");
    expect(html).toContain(" here");
  });

  test("trust stays off: an untrusted \\href emits no link", () => {
    // KaTeX error-renders the unsupported command (source echoed in the mathml
    // annotation) but never emits an anchor.
    const html = render("$\\href{javascript:alert(1)}{x}$");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("katex");
  });

  test("empty string renders nothing", () => {
    expect(render("")).toBe("");
  });
});
