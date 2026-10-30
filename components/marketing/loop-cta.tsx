import { Chunk } from "@/components/settle";
import { BotButton } from "./bot-button";
import { botLink } from "./links";

export function LoopCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16">
      <Chunk
        tone="ink"
        className="flex flex-col items-start gap-6 p-8 sm:p-10 md:flex-row md:items-center"
      >
        <h2 className="flex-1 font-display text-2xl font-extrabold leading-tight sm:text-3xl">
          Get it wrong once, Settle brings it back.
          <br />
          <span className="text-accent">
            Get it wrong twice, it brings it back sooner.
          </span>
        </h2>
        <BotButton href={botLink()} tone="accent" className="shrink-0">
          Try it free on Telegram
        </BotButton>
      </Chunk>
    </section>
  );
}
