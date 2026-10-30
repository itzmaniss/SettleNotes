import { ArrowRight } from "lucide-react";
import { Chunk, Sticker } from "@/components/settle";
import { BotButton } from "./bot-button";
import { botLink } from "./links";

function ChatCard() {
  return (
    <Chunk className="-rotate-2 bg-[#dbe7f2] p-4 text-sm md:absolute md:left-0 md:top-0 md:w-[78%] md:-rotate-3">
      <p className="mb-2 font-mono text-[11px] text-muted-foreground">
        CS2040 grp · 43 unread
      </p>
      <p className="mb-1.5 w-fit rounded-xl bg-card px-3 py-1.5">
        eh lab 4 due when ah
      </p>
      <p className="mb-1.5 w-fit rounded-xl bg-card px-3 py-1.5">
        prof say extend to nxt fri liao
      </p>
      <p className="w-fit rounded-xl bg-card px-3 py-1.5">
        MA1521 quiz 2 this thurs dont forget
      </p>
    </Chunk>
  );
}

function WeekCard() {
  const rows = [
    { title: "MA1521 Quiz 2", due: <span className="font-mono text-xs">THU</span> },
    { title: "GEA1000 Report draft", due: <span className="font-mono text-xs">SUN</span> },
    {
      title: "CS2040 Lab 4",
      due: (
        <span className="rounded-md bg-pop-soft px-1.5 font-mono text-xs">
          FRI 13 ↻
        </span>
      ),
    },
  ];
  return (
    <Chunk
      tone="card"
      className="ml-4 rotate-2 p-5 sm:ml-8 md:absolute md:bottom-6 md:right-0 md:ml-0 md:w-[82%]"
    >
      <div className="flex items-center justify-between">
        <p className="font-display font-bold">Your week</p>
        <Sticker tone="accent">sorted</Sticker>
      </div>
      <div className="mt-4 space-y-2.5 text-[15px]">
        {rows.map((row) => (
          <div key={row.title} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="size-5 shrink-0 rounded-md border-2 border-border bg-card"
            />
            <span className="flex-1 font-medium">{row.title}</span>
            {row.due}
          </div>
        ))}
      </div>
    </Chunk>
  );
}

export function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-12 pt-10 sm:px-6 md:grid-cols-[1.1fr_1fr] md:pb-16 md:pt-16">
      <div>
        <Sticker tone="pop" tilt={-2}>
          made for SG students
        </Sticker>
        <h1 className="mt-6 font-display text-[44px] font-extrabold leading-none tracking-tight sm:text-[52px] md:text-[76px]">
          Stop scrolling the grp chat for deadlines.
        </h1>
        <p className="mt-6 max-w-md text-lg text-muted-foreground">
          Forward anything to the Settle bot. Get one task list, with
          flashcards, checklists and fixes for your math already made.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3">
          <BotButton href={botLink()} tone="accent" className="text-lg">
            Start on Telegram
            <ArrowRight className="size-5" aria-hidden="true" />
          </BotButton>
          <span className="-rotate-3 font-hand text-2xl text-muted-foreground">
            it&apos;s literally a bot
          </span>
        </div>
      </div>
      {/* Stacked chat-to-week cards. In flow below md (chat on top, week
          below with an offset), overlapping absolute layout from md up. */}
      <div className="flex flex-col gap-6 md:relative md:block md:h-[440px]">
        <ChatCard />
        <WeekCard />
      </div>
    </section>
  );
}
