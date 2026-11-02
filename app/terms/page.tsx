import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/legal/legal-document";
import { loadLegalDocument } from "@/lib/legal/content";

// Tokens read env at request time and the Docker build has no env, so the
// page must render per request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Terms",
  description: "The rules for using Settle: accounts, conduct, and the Pro subscription.",
};

export default function TermsPage() {
  return <LegalDocumentView doc={loadLegalDocument("terms")} />;
}
