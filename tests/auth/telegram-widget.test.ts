import { describe, expect, test } from "bun:test";
import { mountTelegramWidget } from "@/components/auth/telegram-widget";

// No DOM library is installed, so these hand written fakes record exactly what
// the helper does: createElement, setAttribute, appendChild, removeChild.
type FakeNode = {
  tagName?: string;
  async?: boolean;
  attributes?: Map<string, string>;
  setAttribute?(name: string, value: string): void;
  getAttribute?(name: string): string | null;
};

type FakeElement = {
  tagName: string;
  async?: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  // Declared as a plain property, implemented as a throwing accessor below.
  innerHTML: string;
};

function fakeDoc() {
  const created: FakeElement[] = [];
  return {
    created,
    createElement(tag: string): FakeElement {
      const el: FakeElement = {
        tagName: tag.toUpperCase(),
        attributes: new Map(),
        setAttribute(name: string, value: string) {
          el.attributes.set(name, value);
        },
        getAttribute(name: string) {
          return el.attributes.get(name) ?? null;
        },
        // Any string-built HTML attempt trips this instead of passing quietly.
        set innerHTML(value: string) {
          throw new Error(`string-built HTML attempted: ${value}`);
        },
      };
      created.push(el);
      return el;
    },
  };
}

function fakeContainer() {
  const childNodes: FakeNode[] = [];
  return {
    childNodes,
    appendChild(child: FakeNode) {
      childNodes.push(child);
      return child;
    },
    removeChild(child: FakeNode) {
      const index = childNodes.indexOf(child);
      if (index !== -1) childNodes.splice(index, 1);
      return child;
    },
  };
}

const TARGET = {
  botUsername: "settle_bot",
  authUrl: "https://settle.example.com/auth/telegram",
};

describe("mountTelegramWidget", () => {
  test("appends exactly one script to the container with the documented attributes", () => {
    const doc = fakeDoc();
    const container = fakeContainer();
    const cleanup = mountTelegramWidget(container, TARGET, doc);

    expect(typeof cleanup).toBe("function");
    expect(container.childNodes.length).toBe(1);
    expect(doc.created.length).toBe(1);

    const script = container.childNodes[0];
    expect(script.tagName).toBe("SCRIPT");
    expect(script.async).toBe(true);
    expect(script.getAttribute?.("src")).toBe("https://telegram.org/js/telegram-widget.js?22");
    expect(script.getAttribute?.("data-telegram-login")).toBe("settle_bot");
    expect(script.getAttribute?.("data-size")).toBe("large");
    expect(script.getAttribute?.("data-userpic")).toBe("false");
    expect(script.getAttribute?.("data-auth-url")).toBe("https://settle.example.com/auth/telegram");
    expect(script.getAttribute?.("data-request-access")).toBe("write");
  });

  test("cleanup removes the script and a second mount appends one script again", () => {
    const doc = fakeDoc();
    const container = fakeContainer();

    const cleanup = mountTelegramWidget(container, TARGET, doc);
    cleanup();
    expect(container.childNodes.length).toBe(0);

    const cleanup2 = mountTelegramWidget(container, TARGET, doc);
    expect(container.childNodes.length).toBe(1);
    expect(doc.created.length).toBe(2);
    cleanup2();
    expect(container.childNodes.length).toBe(0);
  });

  test("mounting while a script is already present never stacks a second one", () => {
    const doc = fakeDoc();
    const container = fakeContainer();

    mountTelegramWidget(container, TARGET, doc);
    const noop = mountTelegramWidget(container, TARGET, doc);

    expect(container.childNodes.length).toBe(1);
    expect(doc.created.length).toBe(1);
    noop();
    expect(container.childNodes.length).toBe(1);
  });

  test("cleanup also removes widget siblings injected next to the script", () => {
    const doc = fakeDoc();
    const container = fakeContainer();

    const cleanup = mountTelegramWidget(container, TARGET, doc);
    // The real widget inserts its iframe immediately before the script tag.
    container.childNodes.unshift({ tagName: "IFRAME" });
    cleanup();

    expect(container.childNodes.length).toBe(0);
  });

  test("a hostile botUsername only ever travels as an attribute value", () => {
    const doc = fakeDoc();
    const container = fakeContainer();
    const hostile = '"><img src=x onerror=alert(1)>';

    mountTelegramWidget(container, { botUsername: hostile, authUrl: TARGET.authUrl }, doc);

    expect(container.childNodes.length).toBe(1);
    const script = container.childNodes[0];
    // Round-trips verbatim through setAttribute; the fake has no HTML string
    // path (its innerHTML accessor throws), so markup building fails loudly.
    expect(script.getAttribute?.("data-telegram-login")).toBe(hostile);
  });
});
