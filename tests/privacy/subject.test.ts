import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./fake-supabase";
import { NAME_A, TELEGRAM_A, USER_A, baseTables } from "./fixtures";
import { SubjectResolutionError, isValidTelegramId, resolveSubject } from "../../lib/privacy/subject";

describe("resolveSubject", () => {
  test("returns the row id when exactly one account matches", async () => {
    const fake = makeFakeDb(baseTables());
    const id = await resolveSubject(fake.client, { telegramId: TELEGRAM_A });
    expect(id).toBe(USER_A);
  });

  test("not_found is a typed error when no account matches", async () => {
    const fake = makeFakeDb(baseTables());
    try {
      await resolveSubject(fake.client, { telegramId: 123456789 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SubjectResolutionError);
      expect((err as SubjectResolutionError).code).toBe("not_found");
    }
  });

  test("ambiguous is a typed error when two rows share the Telegram id", async () => {
    const tables = baseTables();
    tables.users.push({ ...tables.users[0]!, id: "99999999-9999-4999-8999-999999999999" });
    const fake = makeFakeDb(tables);
    try {
      await resolveSubject(fake.client, { telegramId: TELEGRAM_A });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SubjectResolutionError);
      expect((err as SubjectResolutionError).code).toBe("ambiguous");
    }
  });

  test("invalid ids are typed errors: zero, negative, fractional, NaN", async () => {
    const fake = makeFakeDb(baseTables());
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        await resolveSubject(fake.client, { telegramId: bad });
        throw new Error(`should have thrown for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(SubjectResolutionError);
        expect((err as SubjectResolutionError).code).toBe("invalid_id");
      }
    }
  });

  test("the lookup queries only by telegram_user_id, never by name or username", async () => {
    const fake = makeFakeDb(baseTables());
    await resolveSubject(fake.client, { telegramId: TELEGRAM_A });
    const selects = fake.ops.filter((op) => op.kind === "select");
    expect(selects.length).toBe(1);
    const first = selects[0]!;
    if (first.kind !== "select") return;
    expect(first.table).toBe("users");
    expect(first.filters).toEqual([{ column: "telegram_user_id", op: "eq", value: TELEGRAM_A }]);
  });

  test("the subject row's name is never part of the result type", async () => {
    // The resolved value is the uuid only; the sentinel name lives in the row
    // and must not be needed by any caller.
    const fake = makeFakeDb(baseTables());
    const id = await resolveSubject(fake.client, { telegramId: TELEGRAM_A });
    expect(id).not.toContain(NAME_A);
  });
});

describe("isValidTelegramId", () => {
  test("positive safe integers only", () => {
    expect(isValidTelegramId(1)).toBe(true);
    expect(isValidTelegramId(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isValidTelegramId(0)).toBe(false);
    expect(isValidTelegramId(-1)).toBe(false);
    expect(isValidTelegramId(1.5)).toBe(false);
    expect(isValidTelegramId(Number.NaN)).toBe(false);
  });
});
