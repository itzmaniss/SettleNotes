// Pure view model for the /account page: the who-you-are lines and the status
// banner, derived here so the page and panel only render. Imports only the
// client safe copy leaf, so this file stays client safe too.
import {
  BOX_NEEDED_BANNER,
  CANCEL_FIRST_OTHER_BANNER,
  CANCEL_FIRST_STARS_BANNER,
  CANCEL_FIRST_STRIPE_BANNER,
  CANCEL_FIRST_STRIPE_LINK_LABEL,
  DELETE_FAILED_BANNER,
  WORD_NEEDED_BANNER,
} from "./web-copy";

export type AccountBanner = {
  tone: "pop" | "card";
  role: "status" | "alert";
  message: string;
  linkHref: string | null;
  linkLabel: string | null;
};

export type AccountPageView = {
  // The users table has first_name and no username column, so this is the
  // Telegram first name or null.
  firstName: string | null;
  planName: string;
  banner: AccountBanner | null;
};

// cancelKind comes from the ?kind= param the delete action attaches next to
// status=cancel_first: stripe, stars or anything else (paynow, manual).
function cancelFirstBanner(kind: string | null | undefined): AccountBanner {
  if (kind === "stripe") {
    return {
      tone: "pop",
      role: "status",
      message: CANCEL_FIRST_STRIPE_BANNER,
      linkHref: "/billing",
      linkLabel: CANCEL_FIRST_STRIPE_LINK_LABEL,
    };
  }
  if (kind === "stars") {
    return {
      tone: "pop",
      role: "status",
      message: CANCEL_FIRST_STARS_BANNER,
      linkHref: null,
      linkLabel: null,
    };
  }
  return {
    tone: "pop",
    role: "status",
    message: CANCEL_FIRST_OTHER_BANNER,
    linkHref: null,
    linkLabel: null,
  };
}

export function statusBanner(
  status: string | null | undefined,
  cancelKind: string | null | undefined,
): AccountBanner | null {
  switch (status) {
    case "word_needed":
      return { tone: "pop", role: "status", message: WORD_NEEDED_BANNER, linkHref: null, linkLabel: null };
    case "box_needed":
      return { tone: "pop", role: "status", message: BOX_NEEDED_BANNER, linkHref: null, linkLabel: null };
    case "cancel_first":
      return cancelFirstBanner(cancelKind);
    case "delete_failed":
      return { tone: "card", role: "alert", message: DELETE_FAILED_BANNER, linkHref: null, linkLabel: null };
    default:
      return null;
  }
}

export function buildAccountPageView(args: {
  firstName: string | null;
  planName: string;
  status?: string | null;
  cancelKind?: string | null;
}): AccountPageView {
  const firstName = args.firstName == null || args.firstName.trim() === "" ? null : args.firstName;
  return {
    firstName,
    planName: args.planName,
    banner: statusBanner(args.status, args.cancelKind),
  };
}
