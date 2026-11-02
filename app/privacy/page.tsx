import type { Metadata } from "next";

import { LegalDocumentView } from "@/components/legal/legal-document";
import { loadLegalDocument } from "@/lib/legal/content";

// Tokens read env at request time and the Docker build has no env, so the
// page must render per request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What information Settle collects, where it lives, and how to ask for it.",
};

export default function PrivacyPage() {
  return <LegalDocumentView doc={loadLegalDocument("privacy")} />;
}
