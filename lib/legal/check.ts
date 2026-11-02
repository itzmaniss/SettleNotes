// Pure checks over already filled legal text. The check script and the tests
// share this module, so the rules live in one place: no fs, no env, no
// process. Everything is driven through arguments.

import { fillTokens, legalTokens, type LegalTokenEnv } from "./tokens";

export type LegalProblemKind = "marker" | "token" | "placeholder";

export type LegalProblem = {
  // 1-indexed line in the checked text.
  line: number;
  kind: LegalProblemKind;
  excerpt: string;
};

// [[...]] counsel, MISSING and UNKNOWN TOKEN markers.
const MARKER_RE = /\[\[[^\][\n]+\]\]/g;
// {{...}} leftovers, usually a token the document no longer defines.
const TOKEN_RE = /\{\{[^{}\n]+\}\}/g;
// Capitalised scaffolding words a draft must never publish with.
const PLACEHOLDER_RE = /\b(INSERT|TODO|TBD)\b/g;

// Excerpts start at the problem, never before it: the check output must not
// echo filled values such as the operator email that sit earlier in a line.
const EXCERPT_MAX = 80;

function excerptOf(line: string, from: number): string {
  const excerpt = line.slice(from).trimEnd();
  if (excerpt.length <= EXCERPT_MAX) return excerpt;
  return `${excerpt.slice(0, EXCERPT_MAX - 3)}...`;
}

export function findProblems(text: string): LegalProblem[] {
  const problems: LegalProblem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const found: Array<{ at: number; kind: LegalProblemKind }> = [];
    for (const match of line.matchAll(MARKER_RE)) {
      found.push({ at: match.index ?? 0, kind: "marker" });
    }
    for (const match of line.matchAll(TOKEN_RE)) {
      found.push({ at: match.index ?? 0, kind: "token" });
    }
    for (const match of line.matchAll(PLACEHOLDER_RE)) {
      found.push({ at: match.index ?? 0, kind: "placeholder" });
    }
    found.sort((a, b) => a.at - b.at);
    for (const item of found) {
      problems.push({ line: i + 1, kind: item.kind, excerpt: excerptOf(line, item.at) });
    }
  }
  return problems;
}

// The [[...]] texts left in filled text, in document order. content.ts uses
// this to list the counsel questions a document still carries.
export function findMarkers(text: string): string[] {
  return [...text.matchAll(MARKER_RE)].map((match) => match[0]);
}

export type LegalCheckDeps = {
  // Document name (without extension) to source text, e.g. terms -> source.
  sources: Record<string, string>;
  env: LegalTokenEnv;
  version: string;
};

export type LegalCheckResult = { exitCode: number; lines: string[] };

// Fills every source with the tokens built from deps.env, then reports ok or
// one line per problem, then a summary. 1 while anything is unresolved, 0
// when every document is publish ready. Pure: the script only prints.
export function runLegalCheck(deps: LegalCheckDeps): LegalCheckResult {
  const tokens = legalTokens({ env: deps.env, version: deps.version });
  const lines: string[] = [];
  let problems = 0;
  const names = Object.keys(deps.sources);
  for (const name of names) {
    const found = findProblems(fillTokens(deps.sources[name] ?? "", tokens));
    if (found.length === 0) {
      lines.push(`${name}.md: ok`);
      continue;
    }
    for (const problem of found) {
      lines.push(`${name}.md:${problem.line}: ${problem.kind}: ${problem.excerpt}`);
    }
    problems += found.length;
  }
  lines.push(
    problems === 0
      ? `${names.length} files clean`
      : `${names.length} files checked, ${problems} problems`,
  );
  return { exitCode: problems === 0 ? 0 : 1, lines };
}
