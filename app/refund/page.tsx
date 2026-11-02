import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/legal/legal-document";
import { loadLegalDocument } from "@/lib/legal/content";

// Tokens read env at request time and the Docker build has no env, so the
// page must render per request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Refunds",
  description: "How refunds work for Settle Pro, by payment method.",
};

export default function RefundPage() {
  return <LegalDocumentView doc={loadLegalDocument("refund")} />;
}
