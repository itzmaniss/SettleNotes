import type { Metadata } from "next";
import { Caveat, Geist, Geist_Mono, Unbounded } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";

const display = Unbounded({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const hand = Caveat({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-hand",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Settle",
    template: "%s | Settle",
  },
  description:
    "Forward your group chat, PDFs and math photos to a Telegram bot. Settle turns them into one task list and starts each task for you.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${display.variable} ${geistSans.variable} ${geistMono.variable} ${hand.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
