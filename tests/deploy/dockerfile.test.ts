import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const lines = dockerfile.split("\n");
const fromLines = lines.filter((line) => line.trim().startsWith("FROM "));

describe("Dockerfile", () => {
  test("multi-stage: bun musl builder, node musl runtime", () => {
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    expect(fromLines[0]).toContain("FROM oven/bun:1-alpine");
    expect(fromLines.at(-1)).toContain("FROM node:22-alpine");
  });

  test("builder installs with a frozen lockfile and builds standalone", () => {
    expect(dockerfile).toContain("bun install --frozen-lockfile");
    expect(dockerfile).toContain("ENV NEXT_OUTPUT=standalone");
  });

  test("builder strips the traced typescript package after the build", () => {
    const afterBuild = dockerfile.slice(dockerfile.indexOf("RUN bun run build"));
    const runnerStart = afterBuild.indexOf("FROM node:22-alpine");
    const builderTail = afterBuild.slice(0, runnerStart);
    expect(builderTail).toMatch(/rm -rf \.next\/standalone\/node_modules\/typescript/);
  });

  test("runner stage runs only the addgroup and the sourcemap delete", () => {
    const runnerStart = lines.findIndex((line) => line.trim().startsWith("FROM node:22-alpine"));
    const runner = lines.slice(runnerStart).filter((line) => line.trim().startsWith("RUN "));
    expect(runner.length).toBe(2);
    expect(runner.join("\n")).toMatch(/addgroup/);
    expect(runner.join("\n")).toMatch(/find .*-name "\*\.map" .*-delete/);
    expect(runner.join("\n")).not.toContain("rm -rf");
  });

  test("final stage copies the standalone output, static assets, public and content", () => {
    const runnerStart = lines.findIndex((line) => line.trim().startsWith("FROM node:22-alpine"));
    const runner = lines.slice(runnerStart);
    const copies = runner.filter((line) => line.trim().startsWith("COPY "));

    expect(copies.length).toBe(4);
    expect(copies.join("\n")).toContain("/app/.next/standalone ./");
    expect(copies.join("\n")).toContain("/app/.next/static ./.next/static");
    expect(copies.join("\n")).toContain("/app/public ./public");
    expect(copies.join("\n")).toContain("/app/content ./content");
    // Nothing else from the builder (no source, no env files, no lockfile).
    for (const copy of copies) {
      expect(copy).not.toMatch(
        /\.env|package\.json|bun\.lock|\/app\/(?!\.next\/(standalone|static)|public|content)/,
      );
    }
  });

  test("the content folder the image ships is in the repo, with all three documents", () => {
    // The Dockerfile COPY is only honest if the files really exist in the
    // build context; a rename would silently break the legal pages at
    // runtime, so pin the names readLegalSource expects.
    for (const name of ["terms", "privacy", "refund"]) {
      const file = new URL(`../../content/legal/${name}.md`, import.meta.url);
      const text = readFileSync(file, "utf8");
      expect(text.startsWith("# Settle ")).toBe(true);
    }
    // The build context must not drop the folder either.
    const dockerignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");
    expect(dockerignore).not.toMatch(/^\/?content\b/m);
  });

  test("final image runs no package manager and ships no source maps", () => {
    const runnerStart = lines.findIndex((line) => line.trim().startsWith("FROM node:22-alpine"));
    const runner = lines.slice(runnerStart).join("\n");

    expect(runner).not.toMatch(/apk (add|install)|apt-get/);
    expect(runner).toMatch(/find .*-name "\*\.map" .*-delete/);
  });

  test("runs as a non-root user", () => {
    const userLines = lines.filter((line) => line.trim().startsWith("USER "));
    expect(userLines.length).toBe(1);
    expect(userLines[0]).not.toContain("root");
  });

  test("exposes 3000, healthchecks /api/health and starts node server.js", () => {
    expect(dockerfile).toContain("EXPOSE 3000");
    expect(/HEALTHCHECK[\s\S]*\/api\/health/.test(dockerfile)).toBe(true);
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
  });

  test("sets production runtime env with telemetry off", () => {
    expect(dockerfile).toContain("ENV NODE_ENV=production");
    expect(dockerfile).toContain("ENV NEXT_TELEMETRY_DISABLED=1");
    expect(dockerfile).toContain("ENV HOSTNAME=0.0.0.0");
  });

  test("never copies env files and carries no secret-like ARG or ENV values", () => {
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/);
    const offenders = lines.filter(
      (line) => /^(ARG|ENV)\s/i.test(line.trim()) && /(SECRET|KEY|TOKEN)/i.test(line),
    );
    expect(offenders).toEqual([]);
  });
});
