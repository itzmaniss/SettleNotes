import { Chunk, Sticker } from "@/components/settle";

const steps = [
  {
    n: "1",
    title: "Forward it",
    body: "Screenshot, PDF, slides or a photo of your math. Send it to the bot like you would send it to a friend.",
  },
  {
    n: "2",
    title: "Settle sorts it",
    body: "One task list, deadlines in order. A moved deadline updates the task it belongs to.",
  },
  {
    n: "3",
    title: "Your first step is already done",
    body: "Flashcards from your slides, a checklist from the brief, or the exact wrong step in your working.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="mx-auto max-w-6xl scroll-mt-4 px-4 py-12 sm:px-6 md:py-16"
    >
      <h2 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
        How it works
      </h2>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {steps.map((step) => (
          <Chunk key={step.n} tone="card" className="p-5">
            <Sticker tone="accent">{step.n}</Sticker>
            <h3 className="mt-3 font-display font-bold">{step.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{step.body}</p>
          </Chunk>
        ))}
      </div>
    </section>
  );
}
