import { mock } from "bun:test";

// lib/env.ts imports "server-only", which throws outside a React server
// context. Preloaded via bunfig.toml so `bun test` and `bun run <script>`
// can both import it.
mock.module("server-only", () => ({}));
