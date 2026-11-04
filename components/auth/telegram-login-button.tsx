"use client";

import { useEffect, useRef } from "react";
import { mountTelegramWidget } from "@/components/auth/telegram-widget";

// Injects the official Telegram Login Widget. The widget only renders on the
// https domain registered with BotFather (/setdomain), so the login page
// decides between this and a plain bot fallback.
type TelegramLoginButtonProps = {
  botUsername: string;
  authUrl: string;
};

export function TelegramLoginButton({ botUsername, authUrl }: TelegramLoginButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // The widget script inserts its iframe next to itself (document.currentScript)
  // and React 19 hoists JSX <script async> into <head>, where that iframe lands
  // 0x0 and invisible. The tag is appended inside the container at mount time.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return mountTelegramWidget(container, { botUsername, authUrl });
  }, [botUsername, authUrl]);

  return (
    <>
      {/* The widget iframe is opaque, so outside its rounded pill the document
          shows as black corners. The container clips it with a fully rounded
          box sized to the pill (Telegram sets the iframe width to the label,
          hence w-fit), and the outer wrapper centres that box in the card. */}
      <div className="flex w-full justify-center">
        {/* min-h-10 reserves the 40px button slot so layout does not jump on mount. */}
        <div
          ref={containerRef}
          className="mx-auto min-h-10 w-fit overflow-hidden rounded-full [&_iframe]:block"
        />
      </div>
      <noscript>Enable JavaScript to log in with Telegram.</noscript>
    </>
  );
}
