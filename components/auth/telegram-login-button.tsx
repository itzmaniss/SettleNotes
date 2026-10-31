"use client";

// Injects the official Telegram Login Widget script. The widget only renders
// on the https domain registered with BotFather (/setdomain), so the login
// page decides between this and a plain bot fallback.
type TelegramLoginButtonProps = {
  botUsername: string;
  authUrl: string;
};

export function TelegramLoginButton({ botUsername, authUrl }: TelegramLoginButtonProps) {
  return (
    <>
      <script
        async
        src="https://telegram.org/js/telegram-widget.js?22"
        data-telegram-login={botUsername}
        data-size="large"
        data-userpic="false"
        data-auth-url={authUrl}
        data-request-access="write"
      />
      <noscript>Enable JavaScript to log in with Telegram.</noscript>
    </>
  );
}
