import { describe, expect, test } from "bun:test";
import { handleWebhook } from "../../lib/telegram/guards";
import {
  ALLOWED_ID,
  SECRET,
  STRANGER_ID,
  callbackUpdate,
  channelPostUpdate,
  makeDeps,
  textUpdate,
  webhookRequest,
} from "./fixtures";

describe("handleWebhook", () => {
  test("wrong secret returns 401 and touches nothing, body unread", async () => {
    // Body is invalid JSON on purpose: a 401 (not a 400) proves the secret
    // check happens before the body is parsed.
    const ctx = makeDeps();
    const res = await handleWebhook(
      webhookRequest("this is not json", "wrong-secret"),
      ctx.deps,
    );
    expect(res.status).toBe(401);
    expect(ctx.seen).toEqual([]);
    expect(ctx.scheduled).toEqual([]);
  });

  test("missing secret header returns 401", async () => {
    const ctx = makeDeps();
    const res = await handleWebhook(webhookRequest(textUpdate(1), null), ctx.deps);
    expect(res.status).toBe(401);
    expect(ctx.seen).toEqual([]);
    expect(ctx.scheduled).toEqual([]);
  });

  test("invalid JSON returns 400", async () => {
    const ctx = makeDeps();
    const res = await handleWebhook(webhookRequest("{nope"), ctx.deps);
    expect(res.status).toBe(400);
    expect(ctx.seen).toEqual([]);
    expect(ctx.scheduled).toEqual([]);
  });

  test("a body without update_id returns 400", async () => {
    const ctx = makeDeps();
    const res = await handleWebhook(webhookRequest({ hello: true }), ctx.deps);
    expect(res.status).toBe(400);
    expect(ctx.seen).toEqual([]);
  });

  test("duplicate update returns 200 without handling", async () => {
    const seenIds = new Set([7]);
    const ctx = makeDeps({}, seenIds);
    const res = await handleWebhook(webhookRequest(textUpdate(7)), ctx.deps);
    expect(res.status).toBe(200);
    expect(ctx.seen).toEqual([7]);
    expect(ctx.scheduled).toEqual([]);
    expect(ctx.handled).toEqual([]);
    expect(ctx.refusals).toEqual([]);
  });

  test("non-allowlisted sender gets a scheduled refusal on their chat", async () => {
    const ctx = makeDeps();
    const res = await handleWebhook(
      webhookRequest(textUpdate(8, STRANGER_ID, 555)),
      ctx.deps,
    );
    expect(res.status).toBe(200);
    expect(ctx.scheduled).toHaveLength(1);
    // Nothing runs until the scheduler does, so no reply has gone out yet.
    expect(ctx.refusals).toEqual([]);
    await ctx.scheduled[0]!();
    expect(ctx.refusals).toEqual([555]);
    expect(ctx.handled).toEqual([]);
  });

  test("non-allowlisted callback_query gets a refusal on its message chat", async () => {
    const ctx = makeDeps();
    const res = await handleWebhook(
      webhookRequest(callbackUpdate(9, STRANGER_ID)),
      ctx.deps,
    );
    expect(res.status).toBe(200);
    expect(ctx.scheduled).toHaveLength(1);
    await ctx.scheduled[0]!();
    expect(ctx.refusals).toEqual([STRANGER_ID]);
  });

  test("good update returns 200 and schedules handleUpdate with the update", async () => {
    const ctx = makeDeps();
    const update = textUpdate(10);
    const res = await handleWebhook(webhookRequest(update), ctx.deps);
    expect(res.status).toBe(200);
    expect(ctx.scheduled).toHaveLength(1);
    expect(ctx.handled).toEqual([]);
    await ctx.scheduled[0]!();
    expect(ctx.handled).toEqual([update]);
    expect(ctx.refusals).toEqual([]);
  });

  test("a throwing handleUpdate does not reject the scheduled run", async () => {
    const ctx = makeDeps({
      handleUpdate: async () => {
        throw new Error("pipeline exploded");
      },
    });
    const res = await handleWebhook(
      webhookRequest(textUpdate(11, ALLOWED_ID)),
      ctx.deps,
    );
    expect(res.status).toBe(200);
    // Must resolve, never rethrow out of after().
    await expect(ctx.scheduled[0]!()).resolves.toBeUndefined();
  });

  test("update without a sender id is acked and ignored", async () => {
    const ctx = makeDeps();
    const res = await handleWebhook(
      webhookRequest(channelPostUpdate(12)),
      ctx.deps,
    );
    expect(res.status).toBe(200);
    expect(ctx.scheduled).toEqual([]);
    expect(ctx.refusals).toEqual([]);
  });

  test("rejects a webhook secret that is empty on the server", async () => {
    const ctx = makeDeps({ webhookSecret: "" });
    const res = await handleWebhook(
      webhookRequest(textUpdate(13), SECRET),
      ctx.deps,
    );
    expect(res.status).toBe(401);
  });
});
