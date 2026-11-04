import type { Metadata } from "next";
import { Chunk, Logo } from "@/components/settle";
import { BotButton } from "@/components/marketing/bot-button";
import { botLink } from "@/components/marketing/links";
import { DELETED_PAGE_BODY, DELETED_PAGE_BUTTON_LABEL, DELETED_PAGE_TITLE } from "@/lib/account/web-copy";

// A tiny static confirmation page after self serve deletion. Utility page:
// never indexed, never in the sitemap, and robots.txt disallows the /account
// prefix that covers this path too.
export const metadata: Metadata = {
  title: "Account deleted",
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Chunk tone="card" className="w-full max-w-md p-6 text-center sm:p-8">
        <Logo size={40} />
        <h1 className="mt-5 font-display text-2xl font-bold sm:text-3xl">{DELETED_PAGE_TITLE}</h1>
        <p className="mt-4 text-base leading-relaxed">{DELETED_PAGE_BODY}</p>
        <div className="mt-6 flex justify-center">
          <BotButton href={botLink()} tone="accent">
            {DELETED_PAGE_BUTTON_LABEL}
          </BotButton>
        </div>
      </Chunk>
    </main>
  );
}
