import Link from "next/link";

import { listGuideSummaries } from "@/lib/guides/content";

// The landing section for the study guides: five links, each with its
// one-line description from the guide file itself, so the landing can never
// advertise a title the guide page does not carry. A file that fails to load
// drops only its own row. Server safe: no client hooks, nothing but links.
export function GuidesSection() {
  const guides = listGuideSummaries();
  if (guides.length === 0) return null;
  return (
    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16" aria-labelledby="guides-heading">
      <h2
        id="guides-heading"
        className="font-display text-2xl font-extrabold tracking-tight sm:text-3xl"
      >
        Study guides
      </h2>
      <p className="mt-3 max-w-xl text-muted-foreground">
        Short guides on using Settle well, from sorting a group chat to revising your weak spots.
      </p>
      <ul className="mt-6 grid gap-x-8 gap-y-1 md:grid-cols-2">
        {guides.map((guide) => (
          <li key={guide.slug}>
            <Link
              href={`/guides/${guide.slug}`}
              className="block py-3 underline-offset-4 hover:underline"
            >
              <span className="font-medium">{guide.title}</span>
              <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                {guide.description}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
