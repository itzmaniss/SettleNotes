import type { Metadata } from "next";

import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { GUIDE_SLUGS, loadGuide } from "@/lib/guides/content";
import { formatLegalDate } from "@/lib/legal/tokens";
import { buildGuideJsonld, toJsonLdScript } from "@/lib/seo/jsonld";
import { guidePageMetadata } from "@/lib/seo/metadata";
import { siteUrl } from "@/lib/seo/site";

import { GuideBlockView, GuideBreadcrumb, GuideCtaButton } from "../article-view";

type GuidePageProps = {
  params: Promise<{ slug: string }>;
};

// The whitelist is the route list: unknown slugs 404 at routing level, and
// every listed slug prerenders once, because nothing on the page depends on
// the environment.
export const dynamicParams = false;

export function generateStaticParams(): Array<{ slug: string }> {
  return GUIDE_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: GuidePageProps): Promise<Metadata> {
  const { slug } = await params;
  const guide = loadGuide(slug);
  return guidePageMetadata(process.env.APP_BASE_URL, guide);
}

export default async function GuidePage({ params }: GuidePageProps) {
  const { slug } = await params;
  const guide = loadGuide(slug);
  const jsonld = toJsonLdScript(buildGuideJsonld(siteUrl(process.env.APP_BASE_URL), guide));
  return (
    <div className="flex min-h-screen flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonld }} />
      <Nav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8">
        <article className="max-w-[65ch]">
          <GuideBreadcrumb title={guide.title} />
          <h1 className="mt-4 font-display text-3xl font-bold sm:text-4xl">{guide.title}</h1>
          <p className="mt-3 font-mono text-sm text-muted-foreground">
            Last updated {formatLegalDate(guide.updated)}
          </p>
          <div className="mt-6">
            {guide.blocks.map((block, at) => (
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
