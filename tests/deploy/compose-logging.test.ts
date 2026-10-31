import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Container logs live on the VPS and can carry ids and timestamps, so every
// service in deploy/docker-compose.yml must rotate: json-file driver, 10 MB
// per file, 3 files. This is a simple line based check, no YAML dependency.
const text = readFileSync(new URL("../../deploy/docker-compose.yml", import.meta.url), "utf8");
const lines = text.split("\n");

type ServiceBlock = { name: string; lines: string[] };

// Service names sit at exactly two spaces of indent directly under
// "services:"; anything at indent zero (volumes:, comments) ends the section.
function serviceBlocks(allLines: string[]): ServiceBlock[] {
  const start = allLines.findIndex((line) => line.trimEnd() === "services:");
  if (start === -1) return [];
  const blocks: ServiceBlock[] = [];
  let current: ServiceBlock | null = null;
  for (let i = start + 1; i < allLines.length; i++) {
    const line = allLines[i]!;
    if (line.length > 0 && !line.startsWith(" ")) break;
    const service = /^  (\S+):\s*$/.exec(line);
    if (service) {
      current = { name: service[1]!, lines: [] };
      blocks.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return blocks;
}

// The key value pairs of the service's logging block, quotes stripped. Lines
// belong to logging: while they are indented deeper than the service level.
function loggingOptions(block: ServiceBlock): Record<string, string> {
  const at = block.lines.findIndex((line) => line.trim() === "logging:");
  if (at === -1) return {};
  const options: Record<string, string> = {};
  for (let i = at + 1; i < block.lines.length; i++) {
    const line = block.lines[i]!;
    if (line.length > 0 && !line.startsWith("      ")) break;
    const pair = /^\s*([a-z-]+):\s*(.+?)\s*$/.exec(line);
    if (pair) options[pair[1]!] = pair[2]!.replace(/^"|"$/g, "");
  }
  return options;
}

const blocks = serviceBlocks(lines);

describe("deploy/docker-compose.yml log rotation", () => {
  test("the stack still declares its services", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.map((block) => block.name).sort()).toEqual(["app", "caddy"]);
  });

  test("every service rotates with json-file, max-size 10m and max-file 3", () => {
    for (const block of blocks) {
      const options = loggingOptions(block);
      expect([`${block.name} driver`, options.driver]).toEqual([`${block.name} driver`, "json-file"]);
      expect([`${block.name} max-size`, options["max-size"]]).toEqual([`${block.name} max-size`, "10m"]);
      expect([`${block.name} max-file`, options["max-file"]]).toEqual([`${block.name} max-file`, "3"]);
    }
  });

  test("a service without a logging block would fail this test (guard by example)", () => {
    const stripped: ServiceBlock[] = blocks.map((block) => ({
      name: block.name,
      lines: block.lines.filter((line) => line.trim() !== "logging:"),
    }));
    const strippedOptions = loggingOptions(stripped[0]!);
    expect(strippedOptions.driver).toBeUndefined();
    expect(strippedOptions["max-size"]).toBeUndefined();
  });
});
