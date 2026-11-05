// Pure view model for the Account page Calendar block: which state the
// student is in and which banner the ?calendar= param asks for. Client safe.
import {
  CALENDAR_CONNECTED_BANNER,
  CALENDAR_DENIED_BANNER,
  CALENDAR_DISCONNECTED_BANNER,
  CALENDAR_ERROR_BANNER,
  CALENDAR_PRO_BANNER,
} from "./web-copy";

export type CalendarSyncState =
  | "pro_required"
  | "not_connected"
  | "connected"
  | "needs_reconnect";

export type CalendarView = {
  state: CalendarSyncState;
  banner: string | null;
};

export function calendarBannerMessage(value: string | null | undefined): string | null {
  switch (value) {
    case "connected":
      return CALENDAR_CONNECTED_BANNER;
    case "disconnected":
      return CALENDAR_DISCONNECTED_BANNER;
    case "denied":
      return CALENDAR_DENIED_BANNER;
    case "error":
      return CALENDAR_ERROR_BANNER;
    case "pro":
      return CALENDAR_PRO_BANNER;
    default:
      return null;
  }
}

export function buildCalendarView(args: {
  isPro: boolean;
  status: "active" | "needs_reconnect" | null | undefined;
  banner?: string | null;
}): CalendarView {
  let state: CalendarSyncState;
  if (!args.isPro) {
    state = "pro_required";
  } else if (args.status === "active") {
    state = "connected";
  } else if (args.status === "needs_reconnect") {
    state = "needs_reconnect";
  } else {
    state = "not_connected";
  }
  return { state, banner: calendarBannerMessage(args.banner) };
}
