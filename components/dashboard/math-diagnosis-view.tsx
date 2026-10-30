import { Chunk, Sticker } from "@/components/settle";
import { MATH_TOPIC_LABELS, type MathDiagnosis, type MathTopic } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./eyebrow";
import { MathText } from "./math-text";
import { PracticeReveals } from "./practice-reveals";

function topicLabel(topic: MathTopic): string {
  return topic in MATH_TOPIC_LABELS ? MATH_TOPIC_LABELS[topic] : topic;
}

// Math diagnosis: the annotated photo (signed URL minted by the page), the
// numbered steps with the first wrong one ringed in destructive, the
// misconception named, and targeted practice behind reveals.
export function MathDiagnosisView({
  diagnosis,
  imageUrl,
  imageAlt,
}: {
  diagnosis: MathDiagnosis;
  imageUrl: string | null;
  imageAlt: string;
}) {
  const errorStep = diagnosis.first_error_step;

  return (
    <div className="space-y-6">
      {diagnosis.is_correct ? (
        <Chunk tone="accent" className="p-5">
          <p className="font-semibold">This working checks out. Nice one.</p>
          <p className="mt-1 text-sm">
            <span className="font-semibold">Answer check: </span>
            <MathText text={diagnosis.final_answer_check} />
          </p>
        </Chunk>
      ) : (
        <>
          {imageUrl != null ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={imageUrl}
              alt={imageAlt}
              className="w-full rounded-[var(--radius)] border-2 border-border bg-card shadow-[4px_4px_0_0_var(--foreground)]"
            />
          ) : (
            <p className="font-hand text-xl text-muted-foreground">
              The annotated photo for this one is not available right now.
            </p>
          )}

          {diagnosis.steps.length > 0 && (
            <div>
              <Eyebrow as="h3">Your steps</Eyebrow>
              <ol className="mt-2 space-y-2">
                {diagnosis.steps.map((step) => {
                  const slipped = step.index === errorStep;
                  return (
                    <li
                      key={step.index}
                      className={cn(
                        "flex items-start gap-3 p-3",
                        slipped
                          ? "rounded-[var(--radius-sm)] border-2 border-destructive bg-destructive/5"
                          : "rounded-[var(--radius-sm)] bg-card",
                      )}
                    >
                      <span aria-hidden="true" className="shrink-0 font-mono text-xs font-bold text-muted-foreground">
                        {step.index}.
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm leading-relaxed">
                          <MathText text={step.latex_or_text} />
                        </div>
                        {slipped && (
                          <span className="mt-2 inline-block">
                            <Sticker tone="destructive">slipped here</Sticker>
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {diagnosis.what_went_wrong != null && (
            <p className="text-sm leading-relaxed">
              <span className="font-semibold">What went wrong: </span>
              {diagnosis.what_went_wrong}
            </p>
          )}
        </>
      )}

      {diagnosis.misconception != null && (
        <Chunk className="p-5">
          <Eyebrow>Misconception</Eyebrow>
          <p className="mt-1 font-display font-bold">{topicLabel(diagnosis.misconception.topic)}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{diagnosis.misconception.detail}</p>
        </Chunk>
      )}

      {diagnosis.correct_next_step != null && (
        <Chunk tone="pop" className="p-5">
          <Eyebrow>Next step</Eyebrow>
          <p className="mt-1 text-sm leading-relaxed">
            <MathText text={diagnosis.correct_next_step} />
          </p>
        </Chunk>
      )}

      {!diagnosis.is_correct && (
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold">Answer check: </span>
          <MathText text={diagnosis.final_answer_check} />
        </p>
      )}

      <PracticeReveals items={diagnosis.practice} />
    </div>
  );
}
