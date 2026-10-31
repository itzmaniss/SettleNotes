import { describe, expect, test } from "bun:test";
import {
  FAIR_USE_REPLY_TEMPLATE,
  QUOTA_REPLY_TEMPLATE,
  quotaHitReply,
  type QuotaReplyArgs,
} from "../../lib/billing/copy";
import { PLANS, type Feature, type PlanId } from "../../lib/billing/plans";

// 1 Nov 2026 00:00 SGT, the reset instant of the October period.
const NOV_1_SGT = new Date("2026-10-31T16:00:00Z");
// 1 Jan 2027 00:00 SGT, the reset instant of the December period.
const JAN_1_SGT = new Date("2026-12-31T16:00:00Z");

const FEATURES: Feature[] = [
  "chat_capture",
  "math_diagnosis",
  "slides_flashcards",
  "brief_checklist",
  "weak_spot_tracker",
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_ABBRS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

describe("templates", () => {
  test("both templates carry placeholders, never hardcoded numbers or months", () => {
    for (const template of [QUOTA_REPLY_TEMPLATE, FAIR_USE_REPLY_TEMPLATE]) {
      expect(template).toMatch(/\{limit\}/);
      expect(template).toMatch(/\{feature\}/);
      expect(template).toMatch(/\{resetDate\}/);
      expect(template).not.toMatch(/[0-9]/);
      for (const month of [...MONTH_NAMES, ...MONTH_ABBRS]) {
        expect(template).not.toContain(month);
      }
    }
    expect(QUOTA_REPLY_TEMPLATE).toMatch(/\{month\}/);
  });

  test("no em dash or en dash in the templates", () => {
    for (const template of [QUOTA_REPLY_TEMPLATE, FAIR_USE_REPLY_TEMPLATE]) {
      expect(template).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("quotaHitReply", () => {
  test("the free math quota reply for October, exactly as decided", () => {
    expect(
      quotaHitReply({ feature: "math_diagnosis", limit: 3, resetsAt: NOV_1_SGT, reason: "quota" })
    ).toBe(
      "You've used your 3 free math checks for October. They reset on 1 Nov. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan."
    );
  });

  test("singular slide deck when the limit is 1", () => {
    expect(
      quotaHitReply({ feature: "slides_flashcards", limit: 1, resetsAt: NOV_1_SGT, reason: "quota" })
    ).toBe(
      "You've used your 1 free slide deck for October. They reset on 1 Nov. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan."
    );
  });

  test("brief checklist pluralises at 2 and up", () => {
    const out = quotaHitReply({ feature: "brief_checklist", limit: 2, resetsAt: NOV_1_SGT, reason: "quota" });
    expect(out).toContain("2 free brief checklists for October");
  });

  test("fair use on pro uses the reached-the-monthly-limit wording, no free", () => {
    expect(
      quotaHitReply({ feature: "math_diagnosis", limit: 300, resetsAt: NOV_1_SGT, reason: "fair_use" })
    ).toBe(
      "You've reached the monthly limit of 300 math checks. They reset on 1 Nov. Your deadlines and weak spots are still tracked as usual. Send /dashboard to see your plan."
    );
    expect(
      quotaHitReply({ feature: "slides_flashcards", limit: 60, resetsAt: NOV_1_SGT, reason: "fair_use" })
    ).toContain("60 slide decks");
  });

  test("month and reset date follow resetsAt across the year boundary", () => {
    const out = quotaHitReply({ feature: "brief_checklist", limit: 1, resetsAt: JAN_1_SGT, reason: "quota" });
    expect(out).toContain("for December.");
    expect(out).toContain("They reset on 1 Jan.");
  });

  test("an explicit now pins the usage month", () => {
    const out = quotaHitReply({
      feature: "math_diagnosis",
      limit: 3,
      resetsAt: NOV_1_SGT,
      reason: "quota",
      now: new Date("2026-10-20T02:00:00Z"),
    });
    expect(out).toContain("for October.");
  });

  test("every feature and reason stays inside the wording rules", () => {
    const limits = [1, 3, 60, 300];
    for (const feature of FEATURES) {
      for (const reason of ["quota", "fair_use"] as const) {
        for (const limit of limits) {
          for (const resetsAt of [NOV_1_SGT, JAN_1_SGT]) {
            const args: QuotaReplyArgs = { feature, limit, resetsAt, reason };
            const out = quotaHitReply(args);
            expect(out).not.toMatch(/[\u2013\u2014]/);
            expect(out).not.toMatch(/\b(buy|upgrade|subscribe|checkout|pricing|price)\b/i);
            expect(out).not.toMatch(/\bpro\b/i);
            expect(out).not.toMatch(/S\$/);
            expect(out).not.toMatch(/https?:\/\//i);
            expect(out).not.toMatch(/\bwww\./i);
            expect(out).toContain("/dashboard");
            expect(out).toContain("reset");
            expect(out).toContain(String(limit));
          }
        }
      }
    }
  });

  test("the wording still matches every plan quota it will be used with", () => {
    // The nouns must cover the features that can actually be refused.
    for (const planId of ["free", "pro"] as PlanId[]) {
      for (const feature of FEATURES) {
        const quota = PLANS[planId].quotas[feature];
        if (quota === "unlimited" || quota === "off") continue;
        const out = quotaHitReply({
          feature,
          limit: quota,
          resetsAt: NOV_1_SGT,
          reason: planId === "pro" ? "fair_use" : "quota",
        });
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });
});
