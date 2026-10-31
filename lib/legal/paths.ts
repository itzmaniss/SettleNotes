// Single source of truth for where the legal pages live and what they are
// called in navigation. The pages themselves are written separately; these
// paths and labels exist so footers can link to them before they ship and
// nowhere has to hardcode a URL twice.

export const LEGAL_PATHS = {
  terms: "/terms",
  privacy: "/privacy",
  refund: "/refund",
} as const;

export type LegalPageKey = keyof typeof LEGAL_PATHS;

export const LEGAL_LABELS: Record<LegalPageKey, string> = {
  terms: "Terms",
  privacy: "Privacy",
  refund: "Refunds",
};
