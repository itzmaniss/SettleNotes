"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/settle";
import { cn } from "@/lib/utils";

const LINKS = [
  {
    label: "Tasks",
    href: "/dashboard",
    isActive: (path: string) => path === "/dashboard" || path.startsWith("/tasks/"),
  },
  {
    label: "Study",
    href: "/dashboard#study",
    isActive: () => false,
  },
  {
    label: "Weak spots",
    href: "/weak-spots",
    isActive: (path: string) => path.startsWith("/weak-spots"),
  },
  {
    label: "Account",
    href: "/account",
    isActive: (path: string) => path.startsWith("/account"),
  },
  {
    label: "Plan",
    href: "/billing",
    isActive: (path: string) => path.startsWith("/billing"),
    // Phones reach Plan through the slim second row instead: a fifth pill in
    // this row would push Tasks, Study, Weak spots and Account past a 390px
    // screen.
    smOnly: true,
  },
] as const;

const PHONE_LINKS = [
  { label: "Plan", href: "/billing" },
  { label: "Home page", href: "/" },
  { label: "Help", href: "/faq" },
] as const;

export function DashboardNav({ todayLabel }: { todayLabel: string }) {
  const pathname = usePathname();
  return (
    <header className="mx-auto mt-4 w-full max-w-6xl px-4 sm:px-6">
      <div className="flex items-center gap-2 rounded-full border-2 border-border bg-card py-1.5 pl-4 pr-3 shadow-[3px_3px_0_0_var(--foreground)] sm:gap-4 sm:pl-5">
        {/* min-h keeps the brand link on the same 44px tap target as the nav
            pills; the mark is decorative so the accessible name stays settle.
            The wordmark hides below sm: with the Account pill in the row the
            full logo would overflow a 390px screen, and the mark alone keeps
            the same row of pills on one line. */}
        <Link
          href="/dashboard"
          aria-label="settle"
          className="inline-flex min-h-[44px] items-center gap-2 font-display text-lg font-extrabold tracking-tight"
        >
          <Logo size={24} />
          <span className="hidden sm:inline">settle</span>
        </Link>
        <nav aria-label="Dashboard" className="flex items-center gap-1 text-sm font-medium">
          {LINKS.map((link) => {
            const active = link.isActive(pathname);
            return (
              <Link
                key={link.label}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-[44px] items-center whitespace-nowrap rounded-full px-2 py-1 sm:px-3",
                  "smOnly" in link && link.smOnly === true && "hidden sm:flex",
                  active && "border-2 border-border bg-accent text-accent-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <span className="ml-auto hidden font-mono text-xs uppercase tracking-wider text-muted-foreground sm:block">
          {todayLabel}
        </span>
      </div>
      {/* Phone only row under the pill bar: Plan, the public home page and
          Help. Three short labels, about 140px of text in a 328px row on a
          360px screen, spread with justify-between, each label nowrap and
          each link 44px tall, so nothing wraps or overflows. */}
      <div className="mt-2 flex items-center justify-between px-2 text-sm sm:hidden">
        {PHONE_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex min-h-[44px] items-center whitespace-nowrap font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {link.label}
          </Link>
        ))}
      </div>
    </header>
  );
}
