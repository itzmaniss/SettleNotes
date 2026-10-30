import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Check } from "@/components/settle";

describe("Check", () => {
  test("renders an unchecked checkbox with an accessible name", () => {
    const html = renderToStaticMarkup(<Check label="Mark done" />);
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-label="Mark done"');
    expect(html).toContain("data-unchecked");
    expect(html).not.toContain('data-checked=""');
  });

  test("passes aria-label through when no label prop is given", () => {
    const html = renderToStaticMarkup(<Check aria-label="Pick me" />);
    expect(html).toContain('aria-label="Pick me"');
  });

  test("checked state is lime with an ink tick", () => {
    const html = renderToStaticMarkup(<Check label="Done" defaultChecked />);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("data-checked");
    expect(html).toContain("bg-accent");
    expect(html).not.toContain("data-unchecked");
  });

  test("works controlled", () => {
    const html = renderToStaticMarkup(<Check label="Done" checked={true} onCheckedChange={() => {}} />);
    expect(html).toContain('aria-checked="true"');
  });

  test("24px square with 2px border and a 44px hit halo", () => {
    const html = renderToStaticMarkup(<Check label="Done" />);
    expect(html).toContain("size-6");
    expect(html).toContain("border-2");
    expect(html).toContain("rounded-[8px]");
    expect(html).toContain("before:inset-[-10px]");
  });

  test("merges className", () => {
    const html = renderToStaticMarkup(<Check label="Done" className="ml-2" />);
    expect(html).toContain("ml-2");
  });
});
