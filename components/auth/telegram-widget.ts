// The official widget script reads document.currentScript and inserts its
// button iframe immediately before that tag. React 19 hoists JSX <script
// async> into <head>, which stranded the iframe 0x0 in head, so the tag is
// created here and appended inside the caller's container. Only attribute
// APIs are used: the bot username and auth URL reach the DOM as attribute
// values, never as built HTML strings.
const TELEGRAM_WIDGET_SRC = "https://telegram.org/js/telegram-widget.js?22";

export type TelegramWidgetOptions = {
  botUsername: string;
  authUrl: string;
};

// Minimal DOM surface so tests can pass hand written recording fakes.
type MinimalElement = {
  tagName?: string;
  async?: boolean;
  setAttribute(name: string, value: string): void;
  getAttribute?(name: string): string | null;
};

type MinimalContainer = {
  childNodes?: Iterable<unknown>;
  appendChild(child: unknown): unknown;
  removeChild(child: unknown): unknown;
};

type MinimalDocument = {
  createElement(tag: string): MinimalElement;
};

function childrenOf(container: MinimalContainer): unknown[] {
  return container.childNodes ? Array.from(container.childNodes) : [];
}

function isWidgetScript(node: unknown): boolean {
  const el = node as Partial<MinimalElement> | null;
  return (
    el?.tagName === "SCRIPT" &&
    typeof el.getAttribute === "function" &&
    el.getAttribute("data-telegram-login") != null
  );
}

// Appends the widget script tag to container and returns the cleanup, which
// removes the tag plus anything the widget injected next to it. Idempotent: a
// container that already holds the tag gets a no-op cleanup, so React 19
// StrictMode's double effect in dev never stacks two buttons.
export function mountTelegramWidget(
  container: MinimalContainer,
  { botUsername, authUrl }: TelegramWidgetOptions,
  doc: MinimalDocument = document,
): () => void {
  const existing = childrenOf(container);
  if (existing.some(isWidgetScript)) return () => {};

  const script = doc.createElement("script");
  script.async = true;
  script.setAttribute("src", TELEGRAM_WIDGET_SRC);
  script.setAttribute("data-telegram-login", botUsername);
  script.setAttribute("data-size", "large");
  script.setAttribute("data-userpic", "false");
  script.setAttribute("data-auth-url", authUrl);
  script.setAttribute("data-request-access", "write");

  const before = new Set(existing);
  container.appendChild(script);
  return () => {
    for (const child of childrenOf(container)) {
      if (!before.has(child)) container.removeChild(child);
    }
  };
}
