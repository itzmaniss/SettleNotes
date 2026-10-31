import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { resolveNativeButton } from "../../components/ui/button";

describe("resolveNativeButton", () => {
  test("a plain button stays native", () => {
    expect(resolveNativeButton({})).toBe(true);
  });

  test("rendering a link through `render` is not a native button", () => {
    expect(resolveNativeButton({ render: createElement("a", { href: "/x" }) })).toBe(false);
  });

  test("an explicit value always wins", () => {
    expect(resolveNativeButton({ nativeButton: true, render: createElement("button") })).toBe(true);
    expect(resolveNativeButton({ nativeButton: false })).toBe(false);
  });
});
