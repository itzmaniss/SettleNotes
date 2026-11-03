import type { Metadata } from "next";
import { Nav } from "@/components/marketing/nav";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Bento } from "@/components/marketing/bento";
import { Pricing } from "@/components/marketing/pricing";
import { GuidesSection } from "@/components/marketing/guides-section";
import { LoopCta } from "@/components/marketing/loop-cta";
import { Footer } from "@/components/marketing/footer";
import { buildLandingJsonld, toJsonLdScript } from "@/lib/seo/jsonld";
import { landingMetadata } from "@/lib/seo/metadata";
import { siteUrl } from "@/lib/seo/site";

// The raw APP_BASE_URL read matches components/marketing/links.ts: the page
// prerenders with no environment and siteUrl falls back to the production
// origin, so the canonical address and the cards never depend on env at
// request time.
export const metadata: Metadata = landingMetadata(process.env.APP_BASE_URL);

export default function Home() {
  const jsonld = toJsonLdScript(buildLandingJsonld(siteUrl(process.env.APP_BASE_URL)));
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonld }} />
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Bento />
        <Pricing />
        <GuidesSection />
        <LoopCta />
      </main>
      <Footer />
    </>
  );
}
