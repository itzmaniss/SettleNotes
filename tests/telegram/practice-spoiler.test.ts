import { describe, expect, test } from "bun:test";
import {
  escapeHtmlText,
  practiceMessage,
  TELEGRAM_MAX_CHARS,
} from "../../lib/telegram/replies";

const SAMPLE = [
  "3 to try:",
  "1. Solve x²+7x+10=0 by factorising.",
  "2. Solve 2x²+5x-3=0.",
  "3. Expand (x+2)(x+5).",
  "",
  "Answers:",
  "1. It factorises as (x+2)(x+5)=0, so x=-2 or x=-5.",
  "2. x=0.5 or x=-3.",
  "3. x²+7x+10.",
].join("\n");

describe("escapeHtmlText", () => {
  test("escapes every markup character", () => {
    expect(escapeHtmlText('a & b < c > d')).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeHtmlText("</tg-spoiler>")).toBe("&lt;/tg-spoiler&gt;");
    expect(escapeHtmlText('<a href="https://evil.example">tap</a>')).toBe(
      '&lt;a href="https://evil.example"&gt;tap&lt;/a&gt;',
    );
    expect(escapeHtmlText("plain text stays")).toBe("plain text stays");
  });
});

describe("practiceMessage", () => {
  test("wraps the answers block in a spoiler and escapes both parts", () => {
    const message = practiceMessage(SAMPLE);
    expect(message.parseMode).toBe("HTML");
    expect(message.text).toBe(
      [
        "3 to try:",
        "1. Solve x²+7x+10=0 by factorising.",
        "2. Solve 2x²+5x-3=0.",
        "3. Expand (x+2)(x+5).",
        "",
        "<tg-spoiler>Answers:",
        "1. It factorises as (x+2)(x+5)=0, so x=-2 or x=-5.",
        "2. x=0.5 or x=-3.",
        "3. x²+7x+10.</tg-spoiler>",
      ].join("\n"),
    );
    // The fallback carries the readable set with answers visible.
    expect(message.plainText).toBe(SAMPLE);
  });

  test("hostile model text cannot break out of the spoiler", () => {
    const hostile = [
      "1 to try:",
      "1. </tg-spoiler><a href=\"https://evil.example\">claim</a><b>&bold</b>",
      "",
      "Answers:",
      "1. </tg-spoiler><i>injected</i>",
    ].join("\n");
    const message = practiceMessage(hostile);
    expect(message.parseMode).toBe("HTML");
    // Every <, > and & is escaped, so the only live tags are our own pair.
    expect(message.text).not.toContain("</tg-spoiler><a");
    expect(message.text).toContain("&lt;/tg-spoiler&gt;");
    expect(message.text).toContain("&lt;a href=");
    expect(message.text.split("<tg-spoiler>")).toHaveLength(2);
    expect(message.text.split("</tg-spoiler>")).toHaveLength(2);
    expect(message.plainText).toBe(hostile);
  });

  test("text without an answers block stays plain", () => {
    const noAnswers = "1 to try:\n1. 7 - 3 = ?";
    const message = practiceMessage(noAnswers);
    expect(message.parseMode).toBeUndefined();
    expect(message.text).toBe(noAnswers);
    expect(message.plainText).toBe(noAnswers);
  });

  test("an escaped message over the Telegram cap goes out plain", () => {
    const longQuestion = "x".repeat(TELEGRAM_MAX_CHARS);
    const long = `3 to try:\n1. Solve ${longQuestion}=0.\n\nAnswers:\n1. x=0.`;
    const message = practiceMessage(long);
    expect(message.parseMode).toBeUndefined();
    expect(message.text).toBe(long);
    expect(message.text.length).toBeGreaterThan(TELEGRAM_MAX_CHARS);
    expect(message.plainText).toBe(long);
  });
});
