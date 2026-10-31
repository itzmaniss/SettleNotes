// THE one place all consent wording lives. Counsel edits this file and nothing
// else when the agreed wording changes. Rules for every string here: plain
// human sentences, no em or en dashes, no legal claims, and none of the words
// age, minor or liability. Whether wording about young readers or an age check
// is needed is Singapore counsel's call, not ours.
import { LEGAL_PATHS } from "./paths";

// Telegram prompt body, sent before anything about the sender is stored.
export const CONSENT_INTRO =
  "Before we start: Settle saves the messages, photos, PDFs and voice notes you send, so it can turn them into tasks and study help. Please read the Terms and the Privacy Policy, then tap the button below to agree and continue.";

export const CONSENT_BUTTONS = {
  terms: "Terms",
  privacy: "Privacy Policy",
  agree: "I agree and continue",
} as const;

// Prepended when the person agreed before, but to an older version.
export const CONSENT_AGAIN_NOTE =
  "The Terms or Privacy Policy changed since you last agreed, so I need you to agree again before we carry on.";

// Prepended when the blocked message was anything other than /start, so they
// know the thing they sent was dropped, not processed quietly.
export const CONSENT_RESEND_NOTE =
  "Tap the button first, then send that again. I have not saved what you just sent.";

// The prompt message becomes this once the button is tapped.
export const CONSENT_THANKS = "Thanks, you are all set.";

// Checkout refusal shown in the Telegram payment sheet when acceptance is
// missing. It must reassure about money and point back to the chat.
export const CONSENT_PAY_FIRST =
  "One quick thing first: tap the agree button in our chat, then try the payment again. You have not been charged.";

// Fallback for when the buttons cannot be links: Telegram rejects non https
// button URLs, so the two addresses go into the message text as plain lines.
export function CONSENT_PLAIN_LINES(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return [
    `Terms: ${trimmed}${LEGAL_PATHS.terms}`,
    `Privacy Policy: ${trimmed}${LEGAL_PATHS.privacy}`,
  ].join("\n");
}

// ---- web (/accept page) ----------------------------------------------------

export const ACCEPT_TITLE = "One quick step";

export const ACCEPT_BODY =
  "Settle saves the messages, photos, PDFs and voice notes you send, so it can turn them into tasks and study help. Read the Terms and the Privacy Policy below, then agree and continue.";

export const ACCEPT_CONFIRM = "I agree and continue";

export const ACCEPT_DECLINE = "Not now";
