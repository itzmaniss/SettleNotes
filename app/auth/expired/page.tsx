import type { Metadata } from "next";
import Link from "next/link";
import { Chunk, Logo, Sticker } from "@/components/settle";
import { EXPIRED_PAGE_BODY, EXPIRED_PAGE_HINT, EXPIRED_PAGE_TITLE } from "@/lib/auth/copy";

export const metadata: Metadata = {
  title: "Link expired",
  robots: { index: false },
};

export default function ExpiredPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Chunk tone="card" className="w-full max-w-md p-6 text-center sm:p-8">
        <Logo size={40} />
        <Sticker tone="pop" tilt={-2} className="mt-5">
          link expired
        </Sticker>
        <h1 className="mt-5 font-display text-2xl font-bold sm:text-3xl">{EXPIRED_PAGE_TITLE}</h1>
        <p className="mt-4 text-base leading-relaxed">{EXPIRED_PAGE_BODY}</p>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          {EXPIRED_PAGE_HINT}
        </p>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          You can also{" "}
          <Link
            href="/login"
            className="font-semibold underline underline-offset-4 hover:opacity-80"
          >
            log in on the website
          </Link>{" "}
          with Telegram.
        </p>
      </Chunk>
    </main>
  );
}
