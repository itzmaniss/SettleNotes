import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sticker } from "@/components/settle";

function render(tone?: "card" | "accent" | "pop" | "destructive" | "ink", tilt?: number) {
  return renderToStaticMarkup(
    <Sticker tone={tone} tilt={tilt}>
      CS2040
    </Sticker>
  );
}

describe("Sticker", () => {
  test("Unbounded pill with 2px border", () => {
    const html = render();
    expect(html).toContain("font-display");
    expect(html).toContain("text-[11px]");
    expect(html).toContain("font-bold");
    expect(html).toContain("rounded-full");
    expect(html).toContain("border-2");
    expect(html).toContain("px-2.5");
    expect(html).toContain("py-0.5");
  });

  test("tones", () => {
    expect(render("card")).toContain("bg-card");
    expect(render("accent")).toContain("bg-accent");
    expect(render("pop")).toContain("bg-pop-soft");
    expect(render("destructive")).toContain("bg-destructive");
    expect(render("ink")).toContain("bg-foreground");
  });

  test("keeps the casing it is given", () => {
    const html = renderToStaticMarkup(<Sticker>OverDue</Sticker>);
    expect(html).toContain("OverDue");
    expect(html).not.toContain("uppercase");
  });

  test("tilt applies as an inline rotate", () => {
    expect(render(undefined, 4)).toContain("rotate(4deg)");
    expect(render(undefined, -3)).toContain("rotate(-3deg)");
  });

  test("tilt clamps to plus or minus 6 degrees", () => {
    expect(render(undefined, 10)).toContain("rotate(6deg)");
    expect(render(undefined, -10)).toContain("rotate(-6deg)");
    expect(render(undefined, 99)).not.toContain("rotate(99deg)");
  });

  test("no tilt means no transform", () => {
    expect(render()).not.toContain("rotate(");
  });
});
