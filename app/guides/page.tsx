import type { Metadata } from "next";
import Link from "next/link";

import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { listGuides } from "@/lib/guides/content";
import { buildGuidesIndexJsonld, toJsonLdScript } from "@/lib/seo/jsonld";
import { GUIDES_INDEX_DESCRIPTION, GUIDES_INDEX_TITLE, guidesIndexMetadata } from "@/lib/seo/metadata";
import { siteUrl } from "@/lib/seo/site";

// The guides are static: their numbers come from code, not the environment,
// and the files ship in the build context, so every route prerenders once.
export const dynamicParams = false;

export const metadata: Metadata = guidesIndexMetadata(process.env.APP_BASE_URL);

export default function GuidesIndexPage() {
  const guides = listGuides();
  const jsonld = toJsonLdScript(buildGuidesIndexJsonld(siteUrl(process.env.APP_BASE_URL)));
  return (
    <div className="flex min-h-screen flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonld }} />
      <Nav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8">
        <article className="max-w-[65ch]">
          <h1 className="font-display text-3xl font-bold sm:text-4xl">{GUIDES_INDEX_TITLE}</h1>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            {GUIDES_INDEX_DESCRIPTION}
          </p>
          <div className="mt-8 flex flex-col gap-4">
            {guides.map((guide) => (
              <Link
                key={guide.slug}
                href={`/guides/${guide.slug}`}
                className="rounded-[var(--radius)] border-2 border-border bg-card p-4 shadow-[4px_4px_0_0_var(--foreground)] underline-offset-4 transition-transform hover:-translate-y-0.5 hover:underline sm:p-5"
              >
                <span className="block font-display text-lg font-bold">{guide.title}</span>
                <span className="mt-1.5 block text-sm leading-relaxed text-muted-foreground">
                  {guide.description}
                </span>
              </Link>
            ))}
          </div>
          <p className="mt-8 font-mono text-sm text-muted-foreground">
            Looking for answers instead?{" "}
            <Link
              href="/faq"
              className="inline-flex min-h-[44px] items-center text-foreground underline underline-offset-4"
            >
              Questions and answers
            </Link>
          </p>
        </article>
      </main>
      <Footer />
    </div>
  );
}
