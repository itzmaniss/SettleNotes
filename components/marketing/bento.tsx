import { Check, Chunk, FlipCard, Sticker, Tex } from "@/components/settle";

function MathCard() {
  return (
    <Chunk
      tone="accent"
      className="bg-accent/40 p-6 md:col-span-4 md:row-span-2"
    >
      <Sticker tone="card">math photo → the exact mistake</Sticker>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className="space-y-1.5 rounded-xl border-2 border-border bg-[repeating-linear-gradient(#fffdf6_0_27px,#dfe7f1_27px_28px)] p-4 text-lg leading-7">
          <p>
            <Tex tex={String.raw`y = x^2 \sin x`} />
          </p>
          <p>
            <span className="relative inline-block">
              <Tex tex={String.raw`\frac{dy}{dx} = (2x)(\cos x)`} />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -inset-x-2 -inset-y-1 rounded-full border-[3px] border-destructive"
              />
            </span>
          </p>
          <p>
            <Tex tex={String.raw`= 2x \cos x`} />
          </p>
        </div>
        <div>
          <Sticker tone="pop">diagnosis</Sticker>
          <h3 className="mt-3 font-display text-lg font-bold">
            Step 2. Product rule.
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            You multiplied the derivatives. It&apos;s u′v + uv′.
          </p>
          <div className="mt-3 rounded-xl border-2 border-border bg-card p-3 text-center">
            <Tex display tex={String.raw`2x\sin x + x^2\cos x`} />
          </div>
          <p className="mt-3 text-sm font-medium">
            + 3 practice Qs on exactly this
          </p>
        </div>
      </div>
    </Chunk>
  );
}

function FlashcardsCard() {
  return (
    <Chunk tone="card" className="p-5 md:col-span-2">
      <Sticker tone="pop">slides → flashcards</Sticker>
      <FlipCard
        className="mt-4"
        front={
          <span className="font-medium">
            When do you need the chain rule?
          </span>
        }
        back={
          <span className="text-sm">
            When one function sits inside another.{" "}
            <span className="font-mono text-[10px]">slide 12</span>
          </span>
        }
      />
    </Chunk>
  );
}

function ChecklistCard() {
  const rows = [
    { text: "1,500 words max", page: "p.4", done: true },
    { text: "2 charts w/ captions", page: "p.9", done: false },
    { text: "Peer form signed", page: "p.28", done: false },
  ];
  return (
    <Chunk tone="card" className="p-5 md:col-span-2">
      <Sticker tone="card">31-page brief → checklist</Sticker>
      <div className="mt-4 space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.page} className="flex items-center gap-2.5">
            <Check
              label={row.text}
              defaultChecked={row.done}
              className="size-5"
            />
            <span className="flex-1">{row.text}</span>
            <span className="ml-auto font-mono text-xs">{row.page}</span>
          </div>
        ))}
      </div>
    </Chunk>
  );
}

export function Bento() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16">
      <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
        Every task comes pre-started.
      </h2>
      <div className="mt-10 grid gap-6 md:grid-cols-6">
        <MathCard />
        <FlashcardsCard />
        <ChecklistCard />
      </div>
    </section>
  );
}
