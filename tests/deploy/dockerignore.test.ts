import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dockerignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");

describe(".dockerignore", () => {
  test("keeps secrets, VCS state and local installs out of the build context", () => {
    expect(dockerignore).toContain(".env");
    expect(dockerignore).toContain(".git");
    expect(dockerignore).toContain("node_modules");
  });

  test("keeps the env example available despite blanket env exclusions", () => {
    expect(dockerignore).toContain("!.env.example");
  });
});
