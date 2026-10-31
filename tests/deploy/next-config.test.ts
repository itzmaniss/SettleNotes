import { describe, expect, test } from "bun:test";

// Each evaluation gets a fresh module instance via a query-string import so
// process.env.NEXT_OUTPUT at module scope is re-read per case.
async function loadConfig(tag: string): Promise<{
  output?: string;
  outputFileTracingIncludes?: Record<string, string[]>;
  serverExternalPackages?: string[];
}> {
  const mod = await import(`../../next.config.ts?case=${tag}`);
  return mod.default;
}

describe("next.config standalone switch", () => {
  test("without NEXT_OUTPUT the output stays unset (Vercel and dev unchanged)", async () => {
    delete process.env.NEXT_OUTPUT;

    const config = await loadConfig("plain");

    expect(config.output).toBeUndefined();
    expect(config.outputFileTracingIncludes).toBeUndefined();
    expect(config.serverExternalPackages).toContain("sharp");
    expect(config.serverExternalPackages).toContain("ffmpeg-static");
  });

  test("NEXT_OUTPUT=standalone enables standalone output with the native file includes", async () => {
    process.env.NEXT_OUTPUT = "standalone";

    const config = await loadConfig("standalone");

    expect(config.output).toBe("standalone");
    const includes = JSON.stringify(config.outputFileTracingIncludes);
    expect(includes).toContain("ffmpeg-static");
    expect(includes).toContain("sharp");
    expect(includes).toContain("@img");
  });
});
