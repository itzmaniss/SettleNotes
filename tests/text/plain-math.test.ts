import { describe, expect, test } from "bun:test";
import { toPlainMath } from "../../lib/text/plain-math";

// Every conversion the card lists, one row each. First entry is the input,
// second the exact expected output, third an optional note for failures.
const TABLE: Array<[string, string]> = [
  // Delimiters are stripped, the inside is kept and converted.
  ["$x=1$", "x=1"],
  ["$$x=1$$", "x=1"],
  ["\\(x=1\\)", "x=1"],
  ["\\[x=1\\]", "x=1"],
  // Owner example 2: the ASCII hyphen-minus stays as it is, no Unicode minus.
  ["$x^2+4x-5=0$", "x²+4x-5=0"],
  ["$x^{2}$", "x²"],
  ["$x^3+y^4$", "x³+y⁴"],
  ["$2^{10}$", "2¹⁰"],
  ["$x^{-1}$", "x⁻¹"],
  ["$x^{n+1}$", "x^(n+1)"],
  ["$x_1+x_2$", "x₁+x₂"],
  ["$a_{12}$", "a₁₂"],
  ["$x_{n}$", "x_(n)"],
  // Fractions, simple sides lose the parentheses.
  ["$\\frac{1}{2}$", "1/2"],
  ["$\\frac{x}{2}$", "x/2"],
  ["$\\frac{-5}{4}$", "-5/4"],
  ["$\\frac{a+b}{2}$", "(a+b)/2"],
  ["$\\frac{1}{x+1}$", "1/(x+1)"],
  ["\\frac{\\frac{1}{2}}{3}", "(1/2)/3"],
  // Roots.
  ["$\\sqrt{2}$", "√2"],
  ["$\\sqrt{x}$", "√x"],
  ["$\\sqrt{25+24}$", "√(25+24)"],
  ["$\\sqrt[3]{x}$", "∛x"],
  ["$\\sqrt[3]{27}$", "∛27"],
  // Symbols.
  ["$a \\pm b$", "a±b"],
  ["$a \\mp b$", "a∓b"],
  ["$2 \\times 3$", "2×3"],
  ["$a \\cdot b$", "a·b"],
  ["$6 \\div 2$", "6÷2"],
  ["$a \\leq b$", "a≤b"],
  ["$a \\le b$", "a≤b"],
  ["$a \\geq b$", "a≥b"],
  ["$a \\ge b$", "a≥b"],
  ["$a \\neq b$", "a≠b"],
  ["$a \\approx b$", "a≈b"],
  ["$a \\to b$", "a→b"],
  ["$a \\rightarrow b$", "a→b"],
  ["$\\infty$", "∞"],
  ["$\\pi r^2$", "π r²"],
  ["$\\theta$", "θ"],
  ["$\\alpha$", "α"],
  ["$\\beta$", "β"],
  ["$\\Delta$", "Δ"],
  ["$\\sum$", "∑"],
  ["$\\int$", "∫"],
  ["$30^\\circ$", "30°"],
  ["$30^{\\circ}$", "30°"],
  ["$45\\degree$", "45°"],
  // Brackets, text, spacing, unknown commands, braces.
  ["$\\left(x+1\\right)$", "(x+1)"],
  ["$\\text{if } x>0$", "if x>0"],
  ["$\\mathrm{cm}$", "cm"],
  ["$a\\,b$", "a b"],
  ["$a\\;b$", "a b"],
  ["$a\\!b$", "a b"],
  ["$a\\ b$", "a b"],
  ["$\\unknown{x}$", "unknownx"],
  ["${x}$", "x"],
  // Owner example 3, bare LaTeX with no dollar wrapper at all.
  [
    "x=\\frac{-5\\pm\\sqrt{25+24}}{4}=\\frac{-5\\pm 7}{4}",
    "x=(-5±√(25+24))/4=(-5±7)/4",
  ],
  // The owner's full summary sentence, with the dollars gone.
  [
    "Your final answers $x=1$ and $x=-5$ match the true solutions of $x^2+4x-5=0$.",
    "Your final answers x=1 and x=-5 match the true solutions of x²+4x-5=0.",
  ],
  [
    "It factorises as $(x+2)(x+5)=0$, so $x=-2$ or $x=-5$.",
    "It factorises as (x+2)(x+5)=0, so x=-2 or x=-5.",
  ],
  [
    "With $a=2$, $b=5$ and $c=-3$, $x=\\frac{-5\\pm\\sqrt{25+24}}{4}$, so $x=0.5$ or $x=-3$.",
    "With a=2, b=5 and c=-3, x=(-5±√(25+24))/4, so x=0.5 or x=-3.",
  ],
  // Bare carets in prose with no LaTeX delimiters at all.
  ["x^2+4x-5=0", "x²+4x-5=0"],
  ["2^10 is the answer", "2¹⁰ is the answer"],
  ["Expand (x+1)^2 first", "Expand (x+1)² first"],
  ["Simplify a^3 b^2", "Simplify a³ b²"],
  ["It grows by 5^12", "It grows by 5¹²"],
  ["x^2 stays as it is in prose", "x² stays as it is in prose"],
  ["a_b and c^3 in plain text are fine", "a_b and c³ in plain text are fine"],
];

// Prices and ordinary dollar text are never treated as maths. An unattached
// caret and a three digit exponent also stay put.
const UNTOUCHED: string[] = [
  "S$7.99",
  "It costs $5 and $10 in total.",
  "Pro is 5 Stars a month.",
  "I paid $5, she paid $10.",
  "Send $5 to school tomorrow",
  "^2 is a caret at the start",
  "power of 123 stays: x^123",
  "a_b and c_(n+1) in plain text are fine",
  "The answer is x = 4, full stop.",
  "no maths here at all",
  "",
];

describe("toPlainMath", () => {
  test("converts every listed LaTeX form", () => {
    for (const [input, expected] of TABLE) {
      expect([input, toPlainMath(input)]).toEqual([input, expected]);
    }
  });

  test("is idempotent on every table case", () => {
    for (const [input] of TABLE) {
      const once = toPlainMath(input);
      expect([input, toPlainMath(once)]).toEqual([input, once]);
    }
  });

  test("leaves prices and ordinary prose untouched", () => {
    for (const input of UNTOUCHED) {
      expect([input, toPlainMath(input)]).toEqual([input, input]);
    }
  });

  test("is idempotent on the untouched cases", () => {
    for (const input of UNTOUCHED) {
      expect(toPlainMath(toPlainMath(input))).toBe(toPlainMath(input));
    }
  });

  test("an unmatched dollar stays a dollar", () => {
    expect(toPlainMath("that will be $5 please")).toBe("that will be $5 please");
    expect(toPlainMath("total $")).toBe("total $");
  });

  test("a rejected pair keeps both dollars", () => {
    expect(toPlainMath("between $5 and $10 the price is fine")).toBe(
      "between $5 and $10 the price is fine",
    );
  });

  test("tidies whitespace without touching newlines", () => {
    expect(toPlainMath("a  b")).toBe("a b");
    expect(toPlainMath("hello , world .")).toBe("hello, world.");
    expect(toPlainMath("line one\nline two")).toBe("line one\nline two");
    expect(toPlainMath("$a \\pm b$  \nnext")).toBe("a±b\nnext");
    // Maths spacing around a trailing ? is how students read it.
    expect(toPlainMath("7 - 3 = ?")).toBe("7 - 3 = ?");
    expect(toPlainMath("$x = 1$ ?")).toBe("x=1?");
  });

  test("never throws on hostile garbage and stays within the length bound", () => {
    // Seeded xorshift so failures reproduce exactly.
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const pool = [
      "$", "$$", "\\", "\\\\(", "\\)", "\\frac{", "}{", "\\sqrt[", "]{", "^", "_", "{", "}",
      "x", "2", "+", "-", "=", " ", "\n", "\ud83d\ude00", "£", "台", "\\pm", "\\left",
      "\\text{", "S$7.99", "$5 and $10", "\\circ", "}", "^{", "\\pi",
    ];
    for (let i = 0; i < 200; i += 1) {
      const parts: string[] = [];
      const count = next() % 12;
      for (let j = 0; j < count; j += 1) {
        parts.push(pool[next() % pool.length]);
      }
      const input = parts.join("");
      const out = toPlainMath(input);
      expect(typeof out).toBe("string");
      expect(out.length).toBeLessThanOrEqual(input.length * 3 + 16);
      expect(toPlainMath(out)).toBe(out);
    }
  });

  test("the growth guard falls back to the tidied original", () => {
    // Each ^n doubles in size, so a long run would blow past any factor.
    const input = Array.from({ length: 40 }, (_, i) => `\\frac{^{x${i}}}{1}`).join("");
    const out = toPlainMath(input);
    expect(out.length).toBeLessThanOrEqual(input.length * 3 + 16);
  });

  test("non string input returns the empty string", () => {
    expect(toPlainMath(undefined as unknown as string)).toBe("");
    expect(toPlainMath(null as unknown as string)).toBe("");
  });
});
