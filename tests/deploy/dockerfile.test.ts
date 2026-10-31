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

  test("final stage copies only the standalone output, static assets and public", () => {
    const runnerStart = lines.findIndex((line) => line.trim().startsWith("FROM node:22-alpine"));
    const runner = lines.slice(runnerStart);
    const copies = runner.filter((line) => line.trim().startsWith("COPY "));

    expect(copies.length).toBe(3);
    expect(copies.join("\n")).toContain("/app/.next/standalone ./");
    expect(copies.join("\n")).toContain("/app/.next/static ./.next/static");
    expect(copies.join("\n")).toContain("/app/public ./public");
    // Nothing else from the builder (no source, no env files, no lockfile).
    for (const copy of copies) {
      expect(copy).not.toMatch(/\.env|package\.json|bun\.lock|\/app\/(?!\.next\/(standalone|static)|public)/);
    }
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
