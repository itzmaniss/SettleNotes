import type { Metadata } from "next";

import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { loadGuide, faqItemsOf } from "@/lib/guides/content";
import { buildFaqJsonld, toJsonLdScript } from "@/lib/seo/jsonld";
import { FAQ_H1, faqPageMetadata } from "@/lib/seo/metadata";
import { siteUrl } from "@/lib/seo/site";

import { GuideBlockView, GuideCtaButton } from "@/app/guides/article-view";

// Static like the guides: the questions and answers are plain markdown with
// code driven numbers, so the page prerenders once at build.
export const dynamicParams = false;

const faq = loadGuide("faq");

export const metadata: Metadata = faqPageMetadata(process.env.APP_BASE_URL, faq);

export default function FaqPage() {
  const jsonld = toJsonLdScript(
    buildFaqJsonld(siteUrl(process.env.APP_BASE_URL), faqItemsOf(faq)),
  );
  return (
    <div className="flex min-h-screen flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonld }} />
      <Nav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8">
        <article className="max-w-[65ch]">
          <h1 className="font-display text-3xl font-bold sm:text-4xl">{FAQ_H1}</h1>
          <div className="mt-6">
            {faq.blocks.map((block, at) => (
              <GuideBlockView key={at} block={block} />
            ))}
          </div>
          <GuideCtaButton />
        </article>
      </main>
      <Footer />
    </div>
  );
}
