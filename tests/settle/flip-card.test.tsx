import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FlipCard, nextFlipState } from "@/components/settle";

function render(defaultFlipped?: boolean) {
  return renderToStaticMarkup(
    <FlipCard
      defaultFlipped={defaultFlipped}
      front={<span>chain rule question</span>}
      back={<span>f prime of g</span>}
    />
  );
}

describe("FlipCard", () => {
  test("renders a toggle button with aria-pressed", () => {
    const html = render();
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-pressed="false"');
  });

  test("defaultFlipped sets aria-pressed true", () => {
    expect(render(true)).toContain('aria-pressed="true"');
  });

  test("both faces are always in the DOM", () => {
    const html = render(false);
    expect(html).toContain("chain rule question");
    expect(html).toContain("f prime of g");
  });

  test("exactly one face is hidden via aria-hidden and inert", () => {
    const html = render(false);
    expect(html.split('aria-hidden="true"').length - 1).toBe(1);
    expect(html.split('inert=""').length - 1).toBe(1);
  });

  test("with defaultFlipped the front face is the hidden one", () => {
    const html = render(true);
    const front = html.indexOf("chain rule question");
    const hidden = html.indexOf('aria-hidden="true"');
    expect(hidden).toBeGreaterThan(-1);
    expect(hidden).toBeLessThan(front);
  });

  test("front face is card toned, back face is pop soft", () => {
    const html = render();
    expect(html).toContain("bg-card");
    expect(html).toContain("bg-pop-soft");
  });

  test("3D flip wiring: perspective, preserve-3d, backface visibility and springy easing", () => {
    const html = render();
    expect(html).toContain("[perspective:1200px]");
    expect(html).toContain("[transform-style:preserve-3d]");
    expect(html).toContain("[backface-visibility:hidden]");
    expect(html).toContain("ease-[cubic-bezier(.3,1.4,.5,1)]");
    expect(html).toContain("duration-500");
    expect(html).toContain("[transform:rotateY(180deg)]");
  });

  test("reduced motion disables the transition", () => {
    expect(render()).toContain("motion-reduce:transition-none");
  });

  test("merges className", () => {
    const html = renderToStaticMarkup(
      <FlipCard className="h-64" front="a" back="b" />
    );
    expect(html).toContain("h-64");
    expect(html).not.toContain("h-40");
  });
});

describe("nextFlipState", () => {
  test("toggles", () => {
    expect(nextFlipState(false)).toBe(true);
    expect(nextFlipState(true)).toBe(false);
  });
});
