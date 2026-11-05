import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPanel } from "../../components/account/account-panel";
import { buildAccountPageView } from "../../lib/account/view";
import { buildCalendarView, calendarBannerMessage } from "../../lib/calendar/view";
import {
  CALENDAR_CONNECTED_BANNER,
  CALENDAR_CONNECTED_BODY,
  CALENDAR_CONNECT_AGAIN_LABEL,
  CALENDAR_CONNECT_LABEL,
  CALENDAR_DENIED_BANNER,
  CALENDAR_DISCONNECTED_BANNER,
  CALENDAR_DISCONNECT_LABEL,
  CALENDAR_ERROR_BANNER,
  CALENDAR_HEADING,
  CALENDAR_NOT_CONNECTED_BODY,
  CALENDAR_PRO_BANNER,
  CALENDAR_PRO_REQUIRED_BODY,
  CALENDAR_RECONNECT_BODY,
  CALENDAR_SEE_PLANS_LABEL,
} from "../../lib/calendar/web-copy";
import type { CalendarView } from "../../lib/calendar/view";

const FORBIDDEN_DASH = /[\u2013\u2014]/;

function baseView() {
  return buildAccountPageView({ firstName: "Wei", planName: "Pro" });
}

function render(calendar?: CalendarView | null): string {
  return renderToStaticMarkup(
    <AccountPanel view={baseView()} logOut={() => {}} deleteAccount={() => {}} calendar={calendar} />,
  );
}

describe("buildCalendarView", () => {
  test("free users always see pro_required", () => {
    for (const status of ["active", "needs_reconnect", null, undefined] as const) {
      expect(buildCalendarView({ isPro: false, status }).state).toBe("pro_required");
    }
  });

  test("pro state follows the connection row", () => {
    expect(buildCalendarView({ isPro: true, status: "active" }).state).toBe("connected");
    expect(buildCalendarView({ isPro: true, status: "needs_reconnect" }).state).toBe(
      "needs_reconnect",
    );
    expect(buildCalendarView({ isPro: true, status: null }).state).toBe("not_connected");
    expect(buildCalendarView({ isPro: true, status: undefined }).state).toBe("not_connected");
  });

  test("the ?calendar= value maps to its banner, anything else stays quiet", () => {
    expect(calendarBannerMessage("connected")).toBe(CALENDAR_CONNECTED_BANNER);
    expect(calendarBannerMessage("disconnected")).toBe(CALENDAR_DISCONNECTED_BANNER);
    expect(calendarBannerMessage("denied")).toBe(CALENDAR_DENIED_BANNER);
    expect(calendarBannerMessage("error")).toBe(CALENDAR_ERROR_BANNER);
    expect(calendarBannerMessage("pro")).toBe(CALENDAR_PRO_BANNER);
    expect(calendarBannerMessage(undefined)).toBeNull();
    expect(calendarBannerMessage(null)).toBeNull();
    expect(calendarBannerMessage("")).toBeNull();
    expect(calendarBannerMessage("hacked=1")).toBeNull();
    expect(buildCalendarView({ isPro: true, status: null, banner: "connected" }).banner).toBe(
      CALENDAR_CONNECTED_BANNER,
    );
  });

  test("the student copy is exactly the agreed wording", () => {
    expect(CALENDAR_HEADING).toBe("Calendar");
    expect(CALENDAR_PRO_REQUIRED_BODY).toBe("Calendar sync comes with Pro.");
    expect(CALENDAR_SEE_PLANS_LABEL).toBe("See plans");
    expect(CALENDAR_NOT_CONNECTED_BODY).toBe(
      "Put your deadlines in Google Calendar. They show up in a separate calendar called Settle, and Settle cannot see the rest of your calendar.",
    );
    expect(CALENDAR_CONNECT_LABEL).toBe("Connect Google Calendar");
    expect(CALENDAR_CONNECTED_BODY).toBe(
      "Connected. Your deadlines appear in a calendar called Settle.",
    );
    expect(CALENDAR_DISCONNECT_LABEL).toBe("Disconnect");
    expect(CALENDAR_RECONNECT_BODY).toBe("Google Calendar needs you to connect again.");
    expect(CALENDAR_CONNECT_AGAIN_LABEL).toBe("Connect again");
    expect(CALENDAR_CONNECTED_BANNER).toBe("Google Calendar is connected.");
    expect(CALENDAR_DISCONNECTED_BANNER).toBe(
      "Google Calendar is disconnected and the Settle calendar was removed.",
    );
    expect(CALENDAR_DENIED_BANNER).toBe("You did not allow access, so nothing was connected.");
    expect(CALENDAR_ERROR_BANNER).toBe(
      "Something went wrong connecting Google Calendar. Try again.",
    );
    expect(CALENDAR_PRO_BANNER).toBe("Calendar sync comes with Pro.");
  });
});

describe("AccountPanel calendar block", () => {
  test("nothing renders when the feature is off", () => {
    for (const html of [render(), render(null)]) {
      expect(html).not.toContain(CALENDAR_HEADING);
      expect(html).not.toContain(CALENDAR_NOT_CONNECTED_BODY);
      // The two pre-existing forms only: logout and deletion.
      expect((html.match(/<form/g) ?? [])).toHaveLength(2);
    }
  });

  test("pro_required shows the upsell and a link to billing", () => {
    const html = render({ state: "pro_required", banner: null });
    expect(html).toContain(CALENDAR_HEADING);
    expect(html).toContain(CALENDAR_PRO_REQUIRED_BODY);
    expect(html).toContain(CALENDAR_SEE_PLANS_LABEL);
    expect(html).toMatch(/<a [^>]*href="\/billing"[^>]*>[^<]*See plans/);
  });

  test("not_connected links to the connect route", () => {
    const html = render({ state: "not_connected", banner: null });
    expect(html).toContain(CALENDAR_NOT_CONNECTED_BODY);
    expect(html).toMatch(
      /<a [^>]*href="\/api\/calendar\/connect"[^>]*>[^<]*Connect Google Calendar/,
    );
  });

  test("connected shows a disconnect form post", () => {
    const html = render({ state: "connected", banner: null });
    expect(html).toContain(CALENDAR_CONNECTED_BODY);
    expect(html).toContain('action="/api/calendar/disconnect"');
    expect(html).toContain('method="post"');
    expect(html).toContain(CALENDAR_DISCONNECT_LABEL);
    // The two pre-existing forms plus the disconnect form.
    expect((html.match(/<form/g) ?? [])).toHaveLength(3);
  });

  test("needs_reconnect links back to the connect route", () => {
    const html = render({ state: "needs_reconnect", banner: null });
    expect(html).toContain(CALENDAR_RECONNECT_BODY);
    expect(html).toMatch(/<a [^>]*href="\/api\/calendar\/connect"[^>]*>[^<]*Connect again/);
  });

  test("every banner from the calendar routes renders in the block", () => {
    for (const banner of [
      CALENDAR_CONNECTED_BANNER,
      CALENDAR_DISCONNECTED_BANNER,
      CALENDAR_DENIED_BANNER,
      CALENDAR_ERROR_BANNER,
      CALENDAR_PRO_BANNER,
    ]) {
      expect(render({ state: "connected", banner })).toContain(banner);
    }
    expect(render({ state: "connected", banner: null })).not.toContain(CALENDAR_CONNECTED_BANNER);
  });

  test("every calendar control is at least 44px tall", () => {
    for (const state of ["pro_required", "not_connected", "needs_reconnect"] as const) {
      const html = render({ state, banner: null });
      expect(html).toContain("min-h-[44px]");
    }
    const connected = render({ state: "connected", banner: null });
    // The disconnect button rides the chunk default size, which is 44px.
    expect(connected).toContain("h-11");
  });

  test("no em or en dashes in the markup or the calendar sources", () => {
    expect(render({ state: "connected", banner: CALENDAR_CONNECTED_BANNER })).not.toMatch(
      FORBIDDEN_DASH,
    );
    for (const name of ["web-copy.ts", "view.ts", "oauth.ts", "handlers.ts", "runtime.ts", "trigger.ts", "flags.ts"]) {
      const source = readFileSync(new URL(`../../lib/calendar/${name}`, import.meta.url), "utf8");
      expect([name, source.search(FORBIDDEN_DASH)]).toEqual([name, -1]);
    }
    const panel = readFileSync(
      new URL("../../components/account/account-panel.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).not.toMatch(FORBIDDEN_DASH);
  });
});
