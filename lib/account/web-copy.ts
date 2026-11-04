// Client-safe copy for the Account page, the data download and the guarded
// deletion flow. No imports on purpose: a client component may import this
// leaf and never drag server code in with it
// (tests/deploy/client-boundary.test.ts walks the import graph).

export const ACCOUNT_TITLE = "Your account";

export const ACCOUNT_YOU_HEADING = "You";
// The plan block near the top of the You card: the plan name and one link to
// where plans are explained and changed.
export const ACCOUNT_YOUR_PLAN_HEADING = "Your plan";
export const ACCOUNT_PLAN_BILLING_LINK_LABEL = "Plan and billing";
// Shown when the users row has no first name (the only name column it has).
export const ACCOUNT_NAME_FALLBACK = "Signed in with your Telegram account";
export const LOG_OUT_BUTTON_LABEL = "Log out";
// Sessions are signed cookies, so logging out can only clear this browser.
export const ACCOUNT_LOGOUT_NOTE =
  "Logging out clears Settle from this browser only. Your account and your tasks stay.";

export const ACCOUNT_DOWNLOAD_HEADING = "Download your data";
export const ACCOUNT_DOWNLOAD_BODY =
  "Get one JSON file with everything Settle keeps about your account: your tasks, uploads, study material, plan and settings.";
export const ACCOUNT_DOWNLOAD_BUTTON_LABEL = "Download your data";

export const ACCOUNT_DELETE_HEADING = "Delete your account";
export const ACCOUNT_DELETE_BODY =
  "This removes your tasks, uploads, study material and settings from Settle. It cannot be undone. If you have a paid plan, you must cancel it first so you are not charged again.";
export const ACCOUNT_DELETE_WORD_LABEL = "Type DELETE to confirm";
export const ACCOUNT_DELETE_WORD_PLACEHOLDER = "DELETE";
export const ACCOUNT_DELETE_CHECKBOX_LABEL = "I understand this cannot be undone";
export const ACCOUNT_DELETE_BUTTON_LABEL = "Delete my account";

export const ACCOUNT_PRIVACY_LINE =
  "What Settle keeps, and for how long, is written in the Privacy Notice.";
export const ACCOUNT_PRIVACY_LINK_LABEL = "Read the Privacy Notice";

// Status banners, keyed by the status query param the actions redirect with.
export const WORD_NEEDED_BANNER =
  "Type DELETE in the box first, then tap Delete my account.";
export const BOX_NEEDED_BANNER =
  "Tick the confirmation box first so we know you understand.";
// The one plain how-to for cancelling a Stars subscription, shared by the
// deletion banner below and the billing page's Stars line, so the steps are
// never written two different ways.
export const STARS_CANCEL_STEPS =
  "open the Settle chat, tap the bot name, and cancel the subscription in Subscriptions settings";
export const CANCEL_FIRST_STRIPE_BANNER =
  "Cancel your Pro plan on the Billing page first (Manage plan), then come back here so you are not charged again.";
export const CANCEL_FIRST_STRIPE_LINK_LABEL = "Go to Billing";
export const CANCEL_FIRST_STARS_BANNER =
  `Your Pro plan runs through Telegram. Cancel it in Telegram: ${STARS_CANCEL_STEPS}. Then come back here so you are not charged again.`;
export const CANCEL_FIRST_OTHER_BANNER =
  "Your plan is still running. Let it run out first, then come back here.";
export const DELETE_FAILED_BANNER =
  "We could not delete everything just now. Nothing has been lost. Please try again in a minute or email us.";

// Plain text body of the 429 response when the download limit is hit.
export const EXPORT_RATE_LIMIT_LINE =
  "That is a lot of downloads at once. Wait ten minutes and try again.";

// The account deleted page, shown after a successful erase.
export const DELETED_PAGE_TITLE = "Your account is deleted";
export const DELETED_PAGE_BODY =
  "Your tasks, uploads and settings are removed. Payment records are kept for 5 years for accounting, with your Telegram and account numbers removed. If you paid by card, Stripe keeps its own records. You can start again any time by sending /start to the bot.";
export const DELETED_PAGE_BUTTON_LABEL = "Start again on Telegram";
