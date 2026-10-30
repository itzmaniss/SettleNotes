import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Tex } from "@/components/settle";

describe("Tex", () => {
  test("renders katex markup inline", () => {
    const html = renderToStaticMarkup(<Tex tex="x^2" />);
    expect(html).toContain("katex");
    expect(html).toContain("<span");
  });

  test("display mode renders a block div", () => {
    const html = renderToStaticMarkup(<Tex tex="x^2" display />);
    expect(html).toContain("katex");
    expect(html).toContain("<div");
  });

  test("renders mathml alongside the html output", () => {
    const html = renderToStaticMarkup(<Tex tex={"2x\\sin x"} />);
    expect(html).toContain("<math");
  });

  test("broken input does not throw and still renders", () => {
    let html = "";
    expect(() => {
      html = renderToStaticMarkup(<Tex tex={"\\frac{"} />);
    }).not.toThrow();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("katex");
  });
});
