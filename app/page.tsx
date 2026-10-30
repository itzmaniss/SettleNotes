import type { Metadata } from "next";
import { Nav } from "@/components/marketing/nav";
import { Hero } from "@/components/marketing/hero";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Bento } from "@/components/marketing/bento";
import { Pricing } from "@/components/marketing/pricing";
import { LoopCta } from "@/components/marketing/loop-cta";
import { Footer } from "@/components/marketing/footer";

const title = "Settle: your group chat, sorted";
const description =
  "Forward your group chat, PDFs and math photos to the Settle Telegram bot. Settle turns them into one task list, and every task arrives with its first step already done.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: {
    title,
    description,
    type: "website",
  },
};

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Bento />
        <Pricing />
        <LoopCta />
      </main>
      <Footer />
    </>
  );
}
