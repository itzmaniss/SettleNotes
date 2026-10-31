import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// tests/setup.ts mocks "server-only", so unit tests cannot see a client
// component that reaches server-only code through an import chain. Only
// `next build` fails on that. This walks the real import graph instead.
const ROOT = resolve(import.meta.dir, "../..");
const SOURCE_DIRS = ["app", "components", "lib"];
const EXTENSIONS = [".ts", ".tsx"];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // package import
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => join(base, "index" + e)),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

function importsOf(file: string, source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    // Type-only imports are erased at build time.
    if (m[0].includes("import type") || m[0].includes("export type")) continue;
    const target = resolveImport(file, spec);
    if (target) found.push(target);
  }
  return found;
}

const files = SOURCE_DIRS.flatMap((d) => listSourceFiles(join(ROOT, d)));
const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const isServerOnly = (f: string) => /^\s*import\s+["']server-only["']/m.test(sources.get(f) ?? "");
const isClient = (f: string) => /^\s*["']use client["']/m.test(sources.get(f) ?? "");
// Importing a "use server" module from a client component is legitimate: Next
// swaps it for an RPC reference, so its server-only imports never ship.
const isServerActions = (f: string) => /^\s*["']use server["']/m.test(sources.get(f) ?? "");

function chainToServerOnly(start: string): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string, path: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    const src = sources.get(file) ?? readFileSync(file, "utf8");
    for (const next of importsOf(file, src)) {
      if (!sources.has(next)) continue;
      if (isServerActions(next)) continue;
      if (isServerOnly(next)) return [...path, next];
      const hit = walk(next, [...path, next]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(start, [start]);
}

describe("client components never reach server-only modules", () => {
  const clients = files.filter(isClient);

  test("there are client components to check", () => {
    expect(clients.length).toBeGreaterThan(0);
  });

  for (const file of clients) {
    const rel = file.slice(ROOT.length + 1);
    test(rel, () => {
      const chain = chainToServerOnly(file);
      expect(chain === null ? null : chain.map((f) => f.slice(ROOT.length + 1)).join(" -> ")).toBeNull();
    });
  }
});
