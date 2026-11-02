// Client-safe copy for the purchase confirm step (Telegram buttons and the
// web billing checkbox): no imports on purpose, so client components and
// tests can use every string without reaching server code. Each string is
// plain, says no money moved, and names the representation exactly.
export const PURCHASE_CONFIRM_TITLE = "Before you pay";

export const PURCHASE_CONFIRM_BODY =
  "Pro is a paid plan. You must be 18 or older, or have a parent or guardian who has read the Terms and agreed to this purchase.";

export const PURCHASE_CONFIRM_BUTTON = "I am 18 or older, or a parent or guardian agreed";

export const PURCHASE_CONFIRM_CANCEL = "Not now";

export const PURCHASE_CONFIRM_THANKS = "Thanks. Your payment is ready below.";

export const PURCHASE_CONFIRM_DECLINED = "No problem. Send /pro whenever you want to upgrade.";

export const PURCHASE_CONFIRM_FIRST =
  "Please confirm first: send /pro and tap the confirm button. You have not been charged.";

export const PURCHASE_CONFIRM_WEB_LABEL = "I am 18 or older, or a parent or guardian agreed";

export const PURCHASE_CONFIRM_WEB_ERROR =
  "Please tick the box to continue. You have not been charged.";

export const PURCHASE_CONFIRM_FAILED =
  "I could not save that just now. Please try again in a minute. You have not been charged.";
