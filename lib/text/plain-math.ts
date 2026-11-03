// Plain text maths converter: the safety net behind the prompt rule that bans
// LaTeX in student facing text. Telegram does not render LaTeX, so any
// $...$, \\(...\\) or stray \\frac the model still emits has to come out as
// readable plain text with Unicode symbols (x², a/b, √, ±). Pure function,
// no I/O, never throws, safe to import from client code.

// Digits (and a leading minus) in exponent or subscript position.
const SUPERSCRIPTS: Record<string, string> = {
  "0": "\u2070",
  "1": "\u00b9",
  "2": "\u00b2",
  "3": "\u00b3",
  "4": "\u2074",
  "5": "\u2075",
  "6": "\u2076",
  "7": "\u2077",
  "8": "\u2078",
  "9": "\u2079",
  "-": "\u207b",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "\u2080",
  "1": "\u2081",
  "2": "\u2082",
  "3": "\u2083",
  "4": "\u2084",
  "5": "\u2085",
  "6": "\u2086",
  "7": "\u2087",
  "8": "\u2088",
  "9": "\u2089",
};

// Named LaTeX commands with a plain text or Unicode stand in. Unknown names
// keep their letters and lose the backslash.
const SYMBOLS: Record<string, string> = {
  pm: "\u00b1",
  mp: "\u2213",
  times: "\u00d7",
  cdot: "\u00b7",
  div: "\u00f7",
  leq: "\u2264",
  le: "\u2264",
  geq: "\u2265",
  ge: "\u2265",
  neq: "\u2260",
  ne: "\u2260",
  approx: "\u2248",
  to: "\u2192",
  rightarrow: "\u2192",
  Rightarrow: "\u21d2",
  infty: "\u221e",
  pi: "\u03c0",
  theta: "\u03b8",
  alpha: "\u03b1",
  beta: "\u03b2",
  gamma: "\u03b3",
  Delta: "\u0394",
  delta: "\u03b4",
  sum: "\u2211",
  int: "\u222b",
  degree: "\u00b0",
  circ: "\u00b0",
  percent: "%",
  ampersand: "&",
};

// A dollar pair only counts as maths when the inside really looks like it:
// a lone "$5 and $10" or "S$7.99" is a price, not an equation. Strong LaTeX
// markers count on their own; equals signs and letter digit adjacency only
// count when the inside also has a letter, so "10=}+" style garbage never
// turns two price dollars into a maths pair.
function looksLikeMaths(inner: string): boolean {
  if (/\\[a-zA-Z]|\\[,;!]|\\ |[\^_{]/.test(inner)) return true;
  if (!/[a-zA-Z]/.test(inner)) return false;
  return /[a-zA-Z][0-9]|[a-zA-Z][+\-*/=<>]|=/.test(inner);
}

function superscriptOf(inner: string): string {
  const trimmed = inner.trim();
  if (/^-?[0-9]+$/.test(trimmed) && trimmed.replace("-", "").length <= 9) {
    return [...trimmed].map((c) => SUPERSCRIPTS[c] ?? c).join("");
  }
  return `^(${trimmed})`;
}

function subscriptOf(inner: string): string {
  const trimmed = inner.trim();
  if (/^[0-9]+$/.test(trimmed) && trimmed.length <= 9) {
    return [...trimmed].map((c) => SUBSCRIPTS[c] ?? c).join("");
  }
  return `_( ${trimmed} )`.replace(/ /g, "");
}

// Reads a {...} group starting at start. Returns null when unbalanced.
function readGroup(t: string, start: number): { body: string; end: number } | null {
  if (t[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < t.length; i += 1) {
    if (t[i] === "{") depth += 1;
    else if (t[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: t.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

// Simple means a single token or number with an optional leading minus, so
// the slash can sit bare: 1/2, x/2, -5/4.
function isSimple(s: string): boolean {
  return /^-?[a-zA-Z0-9]+$/.test(s);
}

function convertLatex(t: string): string {
  // \cir is handled before scripts so ^\circ lands as a true degree mark.
  let out = t.replace(/\^\{?\\circ\}?/g, "\u00b0");
  // Spacing commands, then the \left and \right prefixes (brackets stay).
  // The lookalike check keeps \rightarrow out of the \right strip.
  out = out.replace(/\\[,;!]/g, " ");
  out = out.replace(/\\ /g, " ");
  out = out.replace(/\\left(?![a-zA-Z])|\\right(?![a-zA-Z])/g, "");
  out = replaceFractions(out);
  out = replaceRoots(out);
  // \text{...} and \mathrm{...} keep their inside as words.
  out = out.replace(/\\(?:text|mathrm)\{([^{}]*)\}/g, "$1");
  out = convertScripts(out);
  // LaTeX line breaks become a space before the command pass.
  out = out.replace(/\\\\/g, " ");
  // Any leftover named command: symbol if known, otherwise bare letters.
  out = out.replace(/\\([a-zA-Z]+)/g, (_m, name: string) => SYMBOLS[name] ?? name);
  // A stray backslash (say from a malformed \\sqrt[) would read as a maths
  // opener on the next pass, so plain text loses every remaining one.
  out = out.replace(/\\/g, "");
  // Grouping braces have no meaning in plain text.
  out = out.replace(/[{}]/g, "");
  // Maths is compact on a phone chat: x=(-5±7)/4, never (-5± 7). Ordinary
  // prose never runs through here, so sentences like "x = 4" stay as they
  // are outside maths.
  out = out.replace(
    / ?([+\-=\u00b1\u2213\u00d7\u00f7\u00b7\u2264\u2265\u2260\u2248\u2192<>]) ?/g,
    "$1",
  );
  return out;
}

// \frac{a}{b} becomes (a)/(b), with the parentheses dropped when the side is
// simple. Nested fractions convert recursively through convertLatex.
function replaceFractions(t: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const idx = t.indexOf("\\frac", i);
    if (idx === -1) {
      out += t.slice(i);
      return out;
    }
    let j = idx + 5;
    while (t[j] === " ") j += 1;
    const num = readGroup(t, j);
    if (num == null) {
      // Malformed: drop the command, keep scanning after it.
      out += t.slice(i, idx);
      i = idx + 5;
      continue;
    }
    j = num.end;
    while (t[j] === " ") j += 1;
    const den = readGroup(t, j);
    if (den == null) {
      out += t.slice(i, idx);
      i = idx + 5;
      continue;
    }
    const n = convertLatex(num.body).trim();
    const d = convertLatex(den.body).trim();
    const body = `${isSimple(n) ? n : `(${n})`}/${isSimple(d) ? d : `(${d})`}`;
    out += t.slice(i, idx) + body;
    i = den.end;
  }
}

// \sqrt{x} becomes √(x), or √x when x is simple; \sqrt[3]{x} becomes ∛(x).
function replaceRoots(t: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const idx = t.indexOf("\\sqrt", i);
    if (idx === -1) {
      out += t.slice(i);
      return out;
    }
    let j = idx + 5;
    let root = "";
    if (t[j] === "[") {
      const close = t.indexOf("]", j + 1);
      if (close !== -1) {
        root = t.slice(j + 1, close).trim();
        j = close + 1;
      }
    }
    while (t[j] === " ") j += 1;
    const group = readGroup(t, j);
    if (group == null) {
      out += t.slice(i, idx);
      i = idx + 5;
      continue;
    }
    const inner = convertLatex(group.body).trim();
    const body = isSimple(inner) ? inner : `(${inner})`;
    const mark = root === "" || root === "2" ? "\u221a" : root === "3" ? "\u221b" : `\u221a[${root}]`;
    out += t.slice(i, idx) + mark + body;
    i = group.end;
  }
}

// ^2, ^{2}, ^{-1} and digit subscripts become Unicode; anything longer or
// non numeric keeps a readable ^( ) form. Only single alphanumerics match
// bare, so an already converted x^(n+1) is never touched again.
function convertScripts(t: string): string {
  let out = t.replace(/\^\{([^{}]*)\}/g, (_m, inner: string) => superscriptOf(inner));
  out = out.replace(/\^([a-zA-Z0-9])(?![a-zA-Z0-9])/g, (_m, ch: string) => superscriptOf(ch));
  out = out.replace(/_\{([^{}]*)\}/g, (_m, inner: string) => subscriptOf(inner));
  out = out.replace(/_([a-zA-Z0-9])(?![a-zA-Z0-9])/g, (_m, ch: string) => subscriptOf(ch));
  return out;
}

// One planned conversion site: a region or a maths dollar pair. start and end
// bound the site in the original text (end exclusive); inner is what converts.
type Site = { start: number; end: number; inner: string };

// Plans all conversion sites in one pass over the ORIGINAL text, so decisions
// never depend on the output shape. \\(...\\) and \\[...\\] are sites
// unconditionally; dollar tokens (collected outside regions, so a region can
// never swallow or shift a dollar) are paired nearest neighbour first, same
// kind with same kind, and a pair becomes a site only when its inside really
// looks like maths. Prices like "$5 and $10" simply never become a site, and
// neither does anything else, which is what makes the result idempotent.
function planSites(text: string): Site[] {
  const sites: Site[] = [];
  const n = text.length;
  const regionOf = new Int32Array(n).fill(-1);
  let i = 0;
  while (i < n) {
    if (text[i] === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = text[i + 1] === "(" ? "\\)" : "\\]";
      const closeAt = text.indexOf(close, i + 2);
      const end = closeAt === -1 ? n : closeAt + close.length;
      for (let k = i; k < end; k += 1) regionOf[k] = sites.length;
      sites.push({ start: i, end, inner: text.slice(i + 2, closeAt === -1 ? n : closeAt) });
      i = end;
      continue;
    }
    i += text[i] === "\\" ? 2 : 1;
  }
  const inRegion = (pos: number): boolean => pos >= 0 && pos < n && regionOf[pos] !== -1;
  // Dollar tokens: a display $$ eats both dollars and pairs with another $$.
  const tokens: Array<{ pos: number; display: boolean }> = [];
  for (let k = 0; k < n; k += 1) {
    if (text[k] !== "$" || inRegion(k)) continue;
    const display = text[k + 1] === "$" && !inRegion(k + 1);
    tokens.push({ pos: k, display });
    if (display) k += 1;
  }
  let t = 0;
  while (t + 1 < tokens.length) {
    const a = tokens[t];
    const b = tokens[t + 1];
    if (a.display !== b.display) {
      t += 1;
      continue;
    }
    const mark = a.display ? 2 : 1;
    const innerStart = a.pos + mark;
    const innerEnd = b.pos;
    // A pair spanning a region is left alone: the region converts on its own.
    let overlaps = false;
    for (let k = innerStart; k < innerEnd && !overlaps; k += 1) {
      if (inRegion(k)) overlaps = true;
    }
    const inner = text.slice(innerStart, innerEnd);
    if (!overlaps && looksLikeMaths(inner)) {
      sites.push({ start: a.pos, end: b.pos + mark, inner });
    }
    t += 2;
  }
  return sites.sort((a, b) => a.start - b.start);
}

function convertSites(text: string): string {
  const sites = planSites(text);
  let out = "";
  let i = 0;
  for (const site of sites) {
    if (site.start < i) continue; // defensive: never overlap
    out += text.slice(i, site.start);
    out += convertLatex(site.inner);
    i = site.end;
  }
  out += text.slice(i);
  return out;
}

// Bare carets in ordinary prose: x^2, 2^10, (x+1)^2 become superscripts even
// with no LaTeX delimiters anywhere. One or two digits only, and the caret
// must sit right after a letter, digit or closing bracket, so "^2 hi", a
// price range or the fallback ^(n+1) style is never touched. Superscript
// output holds no caret, so a second pass finds nothing and stops.
function bareCaretSuperscripts(text: string): string {
  return text.replace(
    /([a-zA-Z0-9)\]])\^([0-9]{1,2})(?![0-9])/g,
    (_m, prev: string, exp: string) => prev + superscriptOf(exp),
  );
}

function tidyWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    // No space before punctuation, except after an operator: "7 - 3 = ?" is
    // maths spacing a student reads, "hello , world" is a typo.
    .replace(/(?<![+\-=<>\u00b1\u00d7\u00f7\u00b7\u2264\u2265\u2260\u2248\u2192]) ([,.;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "");
}

// A conversion must never blow up a Telegram message: cap the growth and fall
// back to the original (whitespace tidied) on a pathological input.
const MAX_GROWTH_FACTOR = 3;
const MAX_GROWTH_SLACK = 16;

export function toPlainMath(text: string): string {
  if (typeof text !== "string") return "";
  try {
    let converted = convertSites(text);
    // Bare LaTeX with no delimiters at all (a fraction pasted into a
    // sentence) converts as well: backslash commands only ever come from
    // maths, so their presence switches the whole string into maths mode.
    if (/\\[a-zA-Z]|\\\\/.test(converted)) converted = convertLatex(converted);
    converted = bareCaretSuperscripts(converted);
    converted = tidyWhitespace(converted);
    if (converted.length > text.length * MAX_GROWTH_FACTOR + MAX_GROWTH_SLACK) {
      return tidyWhitespace(text);
    }
    return converted;
  } catch {
    return text;
  }
}
