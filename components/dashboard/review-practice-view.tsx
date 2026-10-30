import { Chunk } from "@/components/settle";
import { MATH_TOPIC_LABELS, type MathTopic, type ReviewPractice } from "@/lib/starters/types";
import { Eyebrow } from "./eyebrow";
import { PracticeReveals } from "./practice-reveals";

// A weak-spot review task: what tripped you up, and the targeted practice.
export function ReviewPracticeView({ data }: { data: ReviewPractice }) {
  const label = data.topic in MATH_TOPIC_LABELS ? MATH_TOPIC_LABELS[data.topic as MathTopic] : data.topic;
  return (
    <div className="space-y-6">
      <Chunk className="p-5">
        <Eyebrow>Review</Eyebrow>
        <p className="mt-1 font-display font-bold">{label}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{data.misconception}</p>
      </Chunk>
      <PracticeReveals items={data.practice} heading="Practice questions" />
    </div>
  );
}
