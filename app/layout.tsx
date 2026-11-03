import type { Metadata, Viewport } from "next";
import { Caveat, Geist, Geist_Mono, Unbounded } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { rootMetadata, rootViewport } from "@/lib/seo/metadata";

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

// The metadata object itself is built and tested in lib/seo/metadata.ts (this
// file cannot be imported from bun test: the Google fonts need the Next
// runtime). The raw APP_BASE_URL read matches components/marketing/links.ts,
// so prerendering with no environment stays possible.
export const metadata: Metadata = rootMetadata(process.env.APP_BASE_URL);

export const viewport: Viewport = rootViewport;

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
