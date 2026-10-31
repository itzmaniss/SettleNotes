import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Chunk, Sticker } from "@/components/settle";
import { LegalLinks } from "@/components/legal/legal-links";
import { TelegramLoginButton } from "@/components/auth/telegram-login-button";
import { getSessionUser } from "@/lib/auth/session";
import { POST_LOGIN_PATH } from "@/lib/auth/paths";
import {
  LOGIN_PAGE_BOT_LINE,
  LOGIN_PAGE_INTRO,
  loginErrorBanner,
  telegramLoginTarget,
} from "@/lib/auth/telegram-login";

export const metadata: Metadata = {
  title: "Log in",
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await getSessionUser();
  if (session) redirect(POST_LOGIN_PATH);

  const query = await searchParams;
  const banner = loginErrorBanner(query.error);
  // Raw env reads (never lib/env), matching components/marketing/links.ts: the
  // widget needs the https domain registered with BotFather, so local http
  // dev or a missing bot username shows the bot fallback instead.
  const target = telegramLoginTarget(process.env.APP_BASE_URL, process.env.TELEGRAM_BOT_USERNAME);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Chunk tone="card" className="w-full max-w-md p-6 text-center sm:p-8">
        <Sticker tone="accent" tilt={2}>
          log in
        </Sticker>
        <h1 className="mt-5 font-display text-2xl font-bold sm:text-3xl">Log in to Settle</h1>
        <p className="mt-4 text-base leading-relaxed">{LOGIN_PAGE_INTRO}</p>
        {banner ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border-2 border-destructive/40 bg-destructive/10 px-3 py-2 text-sm leading-relaxed text-destructive"
          >
            {banner}
          </p>
        ) : null}
        {target ? (
          <div className="mt-6">
            <TelegramLoginButton botUsername={target.botUsername} authUrl={target.authUrl} />
          </div>
        ) : null}
        <p
          className={
            target
              ? "mt-6 text-sm leading-relaxed text-muted-foreground"
              : "mt-6 text-base leading-relaxed"
          }
        >
          {LOGIN_PAGE_BOT_LINE}
        </p>
        <LegalLinks className="mt-4 justify-center" />
      </Chunk>
    </main>
  );
}
