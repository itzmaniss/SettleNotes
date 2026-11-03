import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/legal/legal-document";
import { loadLegalDocument } from "@/lib/legal/content";
import { legalRobots } from "@/lib/seo/robots";

// Tokens read env at request time and the Docker build has no env, so the
// page must render per request.
export const dynamic = "force-dynamic";

// Metadata rechecks the filled document on every request: while any blank
// still shows as a marker the page is noindex, once every setting is filled
// it becomes indexable and the sitemap picks it up.
export async function generateMetadata(): Promise<Metadata> {
  const doc = loadLegalDocument("refund");
  return {
    title: "Refunds",
    description: "How refunds work for Settle Pro, by payment method.",
    alternates: { canonical: "/refund" },
    robots: legalRobots(doc.markers),
  };
}

export default function RefundPage() {
  return <LegalDocumentView doc={loadLegalDocument("refund")} />;
}
