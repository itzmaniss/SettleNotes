import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard/nav";
import { todayHeading } from "@/lib/dashboard/format";

export const metadata: Metadata = {
  title: {
    default: "Your week",
    template: "%s | Settle",
  },
  robots: { index: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <DashboardNav todayLabel={todayHeading(new Date())} />
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-4 sm:px-6 md:pb-24 md:pt-6">
        {children}
      </main>
    </div>
  );
}
