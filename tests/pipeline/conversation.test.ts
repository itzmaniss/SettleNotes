import { describe, expect, test } from "bun:test";
import { createConversationMemory } from "../../lib/pipeline/conversation";

const MINUTE = 60 * 1000;
const TTL = 10 * MINUTE;

describe("conversation memory", () => {
  test("remember then recent returns turns oldest first with roles kept", () => {
    const memory = createConversationMemory({ now: () => 0 });
    memory.remember("u1", { role: "student", text: "change tutorial to next week" });
    memory.remember("u1", { role: "settle", text: "What is the new due date?" });
    memory.remember("u1", { role: "student", text: "tuesday also" });

    expect(memory.recent("u1")).toEqual([
      { role: "student", text: "change tutorial to next week" },
      { role: "settle", text: "What is the new due date?" },
      { role: "student", text: "tuesday also" },
    ]);
  });

  test("ttl: a turn is alive at 9:59 minutes and gone at 10:01", () => {
    let ms = 0;
    const memory = createConversationMemory({ now: () => ms });
    memory.remember("u1", { role: "student", text: "hello" });

    ms = 9 * MINUTE + 59 * 1000;
    expect(memory.recent("u1")).toHaveLength(1);

    ms = TTL + MINUTE;
    expect(memory.recent("u1")).toEqual([]);
  });

  test("a turn remembered after others expired does not resurrect them", () => {
    let ms = 0;
    const memory = createConversationMemory({ now: () => ms });
    memory.remember("u1", { role: "student", text: "old" });
    ms = TTL + MINUTE;
    memory.remember("u1", { role: "student", text: "new" });
    expect(memory.recent("u1")).toEqual([{ role: "student", text: "new" }]);
  });

  test("only the last maxTurns are kept per user", () => {
    const memory = createConversationMemory({ maxTurns: 2, now: () => 0 });
    memory.remember("u1", { role: "student", text: "one" });
    memory.remember("u1", { role: "settle", text: "two" });
    memory.remember("u1", { role: "student", text: "three" });

    expect(memory.recent("u1")).toEqual([
      { role: "settle", text: "two" },
      { role: "student", text: "three" },
    ]);
  });

  test("text is trimmed and truncated to maxTextChars", () => {
    const memory = createConversationMemory({ maxTextChars: 5, now: () => 0 });
    memory.remember("u1", { role: "student", text: "   hello world   " });
    expect(memory.recent("u1")).toEqual([{ role: "student", text: "hello" }]);
  });

  test("users are isolated from each other", () => {
    const memory = createConversationMemory({ now: () => 0 });
    memory.remember("u1", { role: "student", text: "mine" });
    memory.remember("u2", { role: "student", text: "yours" });

    expect(memory.recent("u1")).toEqual([{ role: "student", text: "mine" }]);
    expect(memory.recent("u2")).toEqual([{ role: "student", text: "yours" }]);
  });

  test("an unknown user gets an empty list", () => {
    const memory = createConversationMemory({ now: () => 0 });
    memory.remember("u1", { role: "student", text: "hi" });
    expect(memory.recent("nobody")).toEqual([]);
  });

  test("beyond maxUsers the least recently used user is evicted", () => {
    const memory = createConversationMemory({ maxUsers: 2, now: () => 0 });
    memory.remember("a", { role: "student", text: "a" });
    memory.remember("b", { role: "student", text: "b" });
    // Reading a makes b the least recently used.
    memory.recent("a");
    memory.remember("c", { role: "student", text: "c" });

    expect(memory.recent("b")).toEqual([]);
    expect(memory.recent("a")).toEqual([{ role: "student", text: "a" }]);
    expect(memory.recent("c")).toEqual([{ role: "student", text: "c" }]);
  });

  test("remembering an existing user keeps them out of eviction", () => {
    const memory = createConversationMemory({ maxUsers: 2, now: () => 0 });
    memory.remember("a", { role: "student", text: "a" });
    memory.remember("b", { role: "student", text: "b" });
    memory.remember("a", { role: "settle", text: "a2" });
    memory.remember("c", { role: "student", text: "c" });

    expect(memory.recent("b")).toEqual([]);
    expect(memory.recent("a")).toEqual([
      { role: "student", text: "a" },
      { role: "settle", text: "a2" },
    ]);
  });
});
