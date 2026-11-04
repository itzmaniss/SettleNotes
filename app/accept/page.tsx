import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Chunk, ChunkButton, Logo, Sticker } from "@/components/settle";
import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { LegalLinks } from "@/components/legal/legal-links";
import { acceptAgree } from "./actions";
import { resolveAcceptVisitor, realAcceptDeps } from "@/lib/auth/accept";
import { CONSENT_COOKIE } from "@/lib/auth/consent-cookie";
import { SESSION_COOKIE } from "@/lib/auth/jwt";
import { POST_LOGIN_PATH, safeNextPath } from "@/lib/auth/paths";
import { ACCEPT_BODY, ACCEPT_CONFIRM, ACCEPT_DECLINE, ACCEPT_TITLE } from "@/lib/legal/consent-copy";

export const metadata: Metadata = {
  title: "One quick step",
  robots: { index: false, follow: false },
};

type AcceptPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Public on purpose: reached from the Telegram web login handoff (consent
// cookie) or by a signed-in user whose acceptance is missing or stale. It must
// never sit behind the session middleware matcher.
export default async function AcceptPage({ searchParams }: AcceptPageProps) {
  const query = await searchParams;
  const next = safeNextPath(typeof query.next === "string" ? query.next : null);

  const store = await cookies();
  const visitor = await resolveAcceptVisitor(realAcceptDeps(), {
    consentToken: store.get(CONSENT_COOKIE)?.value,
    sessionToken: store.get(SESSION_COOKIE)?.value,
  });
  if (visitor === null) redirect("/login");
  if (visitor.kind === "accepted") redirect(POST_LOGIN_PATH);

  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <Chunk tone="card" className="w-full max-w-md p-6 text-center sm:p-8">
          <Logo size={40} />
          <Sticker tone="accent" tilt={2} className="mt-5">
            one step
          </Sticker>
          <h1 className="mt-5 font-display text-2xl font-bold sm:text-3xl">{ACCEPT_TITLE}</h1>
          <p className="mt-4 text-base leading-relaxed">{ACCEPT_BODY}</p>
          <LegalLinks className="mt-4 justify-center" />
          {/* Identity is re-verified from the cookies inside the action; the
              hidden field only carries the constrained navigation hint. */}
          <form action={acceptAgree} className="mt-6">
            <input type="hidden" name="next" value={next} />
            <ChunkButton type="submit" className="w-full">
              {ACCEPT_CONFIRM}
            </ChunkButton>
          </form>
          <Link
            href="/"
            className="mt-3 inline-flex min-h-[44px] items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {ACCEPT_DECLINE}
          </Link>
        </Chunk>
      </main>
      <Footer />
    </div>
  );
}
