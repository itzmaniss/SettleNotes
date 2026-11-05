// Client-safe copy for the Account page Calendar block. No imports on
// purpose, same as lib/account/web-copy.ts: a client component may import
// this leaf and never drag server code in with it.

export const CALENDAR_HEADING = "Calendar";

export const CALENDAR_PRO_REQUIRED_BODY = "Calendar sync comes with Pro.";
export const CALENDAR_SEE_PLANS_LABEL = "See plans";

export const CALENDAR_NOT_CONNECTED_BODY =
  "Put your deadlines in Google Calendar. They show up in a separate calendar called Settle, and Settle cannot see the rest of your calendar.";
export const CALENDAR_CONNECT_LABEL = "Connect Google Calendar";

export const CALENDAR_CONNECTED_BODY =
  "Connected. Your deadlines appear in a calendar called Settle.";
export const CALENDAR_DISCONNECT_LABEL = "Disconnect";

export const CALENDAR_RECONNECT_BODY = "Google Calendar needs you to connect again.";
export const CALENDAR_CONNECT_AGAIN_LABEL = "Connect again";

// Status banners, keyed by the ?calendar= param the calendar routes redirect with.
export const CALENDAR_CONNECTED_BANNER = "Google Calendar is connected.";
export const CALENDAR_DISCONNECTED_BANNER =
  "Google Calendar is disconnected and the Settle calendar was removed.";
export const CALENDAR_DENIED_BANNER = "You did not allow access, so nothing was connected.";
export const CALENDAR_ERROR_BANNER = "Something went wrong connecting Google Calendar. Try again.";
export const CALENDAR_PRO_BANNER = "Calendar sync comes with Pro.";
