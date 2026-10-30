import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";
import { ChunkButton } from "@/components/settle";

describe("Button default variants unchanged", () => {
  test("default variant keeps its classes", () => {
    const html = renderToStaticMarkup(<Button>Go</Button>);
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
    expect(html).toContain("rounded-lg");
    expect(html).toContain("h-8");
    expect(html).not.toContain("rounded-full");
  });

  test("outline variant keeps its classes", () => {
    const html = renderToStaticMarkup(<Button variant="outline">Go</Button>);
    expect(html).toContain("border-border");
    expect(html).toContain("bg-background");
  });

  test("tone is inert on non-chunk variants", () => {
    const html = renderToStaticMarkup(<Button tone="ink">Go</Button>);
    expect(html).not.toContain("bg-foreground");
    expect(html).toContain("bg-primary");
  });
});

describe("Button chunk variant", () => {
  test("pill with 2px border, hard shadow and press state", () => {
    const html = renderToStaticMarkup(<Button variant="chunk">Go</Button>);
    expect(html).toContain("rounded-full");
    expect(html).toContain("border-2");
    expect(html).toContain("border-border");
    expect(html).toContain("shadow-[3px_3px_0_0_var(--foreground)]");
    expect(html).toContain("active:translate-x-[3px]");
    expect(html).toContain("active:translate-y-[3px]");
    expect(html).toContain("active:shadow-none");
    expect(html).toContain("font-semibold");
  });

  test("size default gives at least a 44px tap height", () => {
    const html = renderToStaticMarkup(<Button variant="chunk">Go</Button>);
    expect(html).toContain("h-11");
    expect(html).not.toContain("h-8");
  });

  test("accent tone is the default chunk tone", () => {
    const html = renderToStaticMarkup(<Button variant="chunk">Go</Button>);
    expect(html).toContain("bg-accent");
    expect(html).toContain("text-accent-foreground");
  });

  test("ink tone", () => {
    const html = renderToStaticMarkup(
      <Button variant="chunk" tone="ink">
        Go
      </Button>
    );
    expect(html).toContain("bg-foreground");
    expect(html).toContain("text-background");
    expect(html).not.toContain("bg-accent");
  });

  test("card tone", () => {
    const html = renderToStaticMarkup(
      <Button variant="chunk" tone="card">
        Go
      </Button>
    );
    expect(html).toContain("bg-card");
    expect(html).not.toContain("bg-accent");
  });
});

describe("ChunkButton wrapper", () => {
  test("renders the chunk variant with the accent tone by default", () => {
    const html = renderToStaticMarkup(<ChunkButton>Start</ChunkButton>);
    expect(html).toContain("rounded-full");
    expect(html).toContain("bg-accent");
    expect(html).toContain("h-11");
  });

  test("passes the ink tone through", () => {
    const html = renderToStaticMarkup(<ChunkButton tone="ink">Start</ChunkButton>);
    expect(html).toContain("bg-foreground");
    expect(html).toContain("text-background");
  });
});
