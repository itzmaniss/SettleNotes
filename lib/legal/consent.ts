// Pure consent decision over a users row. Acceptance counts only when BOTH
// columns are set and the stored version still equals TERMS_VERSION; bumping
// the version in lib/legal/version.ts is what makes everyone accept again.
// A row without either column (everyone who existed before migration 0004)
// is "stale", never "ok".
import { TERMS_VERSION } from "./version";

export type ConsentInputs = {
  terms_accepted_at: string | null;
  terms_version: string | null;
};

export type ConsentStatus = "none" | "stale" | "ok";

export function hasAcceptedCurrentTerms(
  user: ConsentInputs | null | undefined,
): boolean {
  if (user == null) return false;
  return user.terms_accepted_at != null && user.terms_version === TERMS_VERSION;
}

export function consentStatus(user: ConsentInputs | null | undefined): ConsentStatus {
  if (user == null) return "none";
  return hasAcceptedCurrentTerms(user) ? "ok" : "stale";
}
