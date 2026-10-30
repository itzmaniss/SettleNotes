"use client";

import { useState } from "react";
import { Check as CheckIcon } from "lucide-react";
import {
  Chunk,
  ChunkButton,
  Sticker,
} from "@/components/settle";
import type { PlanId } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import { BotButton } from "./bot-button";

// Everything here arrives pre-formatted from the server: names, bullets and
// price strings all originate in lib/billing/plans.ts. No numbers in JSX.
export type PricingCardData = {
  id: PlanId;
  name: string;
  priceMonthly: string;
  priceYearly: string;
  yearlyPerMonth: string | null;
  anchor: string | null;
  bullets: string[];
};

export type PricingSectionProps = {
  cards: PricingCardData[];
  billingEnabled: boolean;
  botHref: string | null;
  yearlySavePercent: number;
  heading: React.ReactNode;
  defaultPeriod?: "monthly" | "yearly";
};

type Period = "monthly" | "yearly";

function PeriodButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "min-h-11 rounded-full px-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active && "bg-foreground text-background"
      )}
    >
      {children}
    </button>
  );
}

function BulletTick() {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border-2 border-border bg-card"
    >
      <CheckIcon className="size-3" strokeWidth={3} />
    </span>
  );
}

export function PricingSection({
  cards,
  billingEnabled,
  botHref,
  yearlySavePercent,
  heading,
  defaultPeriod = "monthly",
}: PricingSectionProps) {
  const [period, setPeriod] = useState<Period>(defaultPeriod);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-4">
        {heading}
        <div
          role="group"
          aria-label="Billing period"
          className="flex rounded-full border-2 border-border bg-card p-1 text-sm font-semibold"
        >
          <PeriodButton
            active={period === "monthly"}
            onClick={() => setPeriod("monthly")}
          >
            Monthly
          </PeriodButton>
          <PeriodButton
            active={period === "yearly"}
            onClick={() => setPeriod("yearly")}
          >
            Yearly
            {yearlySavePercent > 0 && (
              <span className="ms-1 text-xs font-normal">
                save {yearlySavePercent}%
              </span>
            )}
          </PeriodButton>
        </div>
      </div>
      <div className="mt-10 grid gap-6 md:grid-cols-[1fr_1.2fr]">
        {cards.map((card) => {
          const isPro = card.id === "pro";
          return (
            <Chunk
              key={card.id}
              tone={isPro ? "accent" : "card"}
              data-plan={card.id}
              className="relative p-6 sm:p-7"
            >
              {card.anchor !== null && (
                <Sticker
                  tone="pop"
                  tilt={3}
                  className="absolute -top-4 right-4 sm:right-6"
                >
                  {card.anchor}
                </Sticker>
              )}
              <h3 className="font-display text-lg font-bold">{card.name}</h3>
              <p className="mt-3 font-display text-5xl font-extrabold">
                {period === "monthly" ? card.priceMonthly : card.priceYearly}
              </p>
              <p
                className={cn(
                  "mt-1 text-sm",
                  isPro ? "text-accent-foreground" : "text-muted-foreground"
                )}
              >
                {period === "monthly"
                  ? isPro
                    ? "a month"
                    : "forever"
                  : card.yearlyPerMonth === null
                    ? "a year"
                    : `a year, about ${card.yearlyPerMonth} a month`}
              </p>
              <ul className="mt-6 space-y-3 text-[15px]">
                {card.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-3">
                    <BulletTick />
                    {bullet}
                  </li>
                ))}
              </ul>
              {isPro ? (
                <>
                  {billingEnabled ? (
                    <ChunkButton
                      tone="ink"
                      className="mt-8 w-full justify-center"
                      render={<a href="/billing" />}
                    >
                      Get Pro
                    </ChunkButton>
                  ) : (
                    <ChunkButton
                      tone="ink"
                      disabled
                      className="mt-8 w-full justify-center"
                    >
                      Coming soon
                    </ChunkButton>
                  )}
                  {billingEnabled && (
                    <p className="mt-3 text-center text-xs text-accent-foreground">
                      Pay with card or Telegram Stars.
                    </p>
                  )}
                </>
              ) : (
                <BotButton
                  href={botHref}
                  tone="card"
                  className="mt-8 w-full justify-center"
                >
                  Start on Telegram
                </BotButton>
              )}
            </Chunk>
          );
        })}
      </div>
    </>
  );
}
