import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSessionUser } from "@/lib/auth/session";
import { signedUrl } from "@/lib/media/storage";
import {
  getStarterForTask,
  getTaskForUser,
  listTaskEvents,
} from "@/lib/db/dashboard-queries";
import { formatDoneDueLine, formatDueLine } from "@/lib/dashboard/format";
import { kindSticker, statusSticker } from "@/lib/dashboard/stickers";
import { parseStarterContent } from "@/lib/starters/types";
import { Sticker } from "@/components/settle";
import { TaskDoneToggle } from "@/components/dashboard/task-done-toggle";
import { ChecklistView } from "@/components/dashboard/checklist-view";
import { FlashcardsView } from "@/components/dashboard/flashcards-view";
import { MathDiagnosisView } from "@/components/dashboard/math-diagnosis-view";
import { ReviewPracticeView } from "@/components/dashboard/review-practice-view";
import { HistoryList } from "@/components/dashboard/history-list";
import { EmptyNote } from "@/components/dashboard/empty-note";
import { cn } from "@/lib/utils";

type TaskPageProps = { params: Promise<{ id: string }> };

// A malformed id would make Postgres throw (invalid uuid) and show the error
// page; treat it as plain "not found" instead.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: TaskPageProps): Promise<Metadata> {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return { title: "Task" };
  const { userId } = await requireSessionUser();
  const task = await getTaskForUser(userId, id);
  return { title: task?.title ?? "Task" };
}

export default async function TaskPage({ params }: TaskPageProps) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const { userId } = await requireSessionUser();

  const task = await getTaskForUser(userId, id);
  if (task == null) notFound();

  const now = new Date();
  const [starter, events] = await Promise.all([
    getStarterForTask(userId, task.id),
    listTaskEvents(userId, task.id),
  ]);

  // The annotated math photo is private Storage, so the page mints a one hour
  // signed URL server-side.
  const imageUrl =
    starter != null && starter.annotated_image_path != null
      ? await signedUrl(starter.annotated_image_path, 3600)
      : null;

  const due =
    task.status === "done"
      ? { text: formatDoneDueLine(task.due_at), overdue: false }
      : formatDueLine(task.due_at, now);
  const kind = kindSticker(task.kind);
  const status = statusSticker(task, events[0] ?? null, now);

  let starterView: React.ReactNode = (
    <EmptyNote>
      Nothing prepared yet. Send the doc or photo to me in Telegram and I will get it ready.
    </EmptyNote>
  );
  if (starter != null) {
    const parsed = parseStarterContent(starter.type, starter.content);
    if (parsed.ok) {
      switch (parsed.data.type) {
        case "checklist":
          starterView = (
            <ChecklistView
              taskId={task.id}
              starterId={starter.id}
              items={parsed.data.content.items}
            />
          );
          break;
        case "flashcards":
          starterView = (
            <FlashcardsView
              cards={parsed.data.content.cards}
              practice={parsed.data.content.practice}
            />
          );
          break;
        case "math_diagnosis":
          starterView = (
            <MathDiagnosisView
              diagnosis={parsed.data.content}
              imageUrl={imageUrl}
              imageAlt={
                diagnosisAlt(parsed.data.content.first_error_step, parsed.data.content.is_correct)
              }
            />
          );
          break;
        case "review_practice":
          starterView = <ReviewPracticeView data={parsed.data.content} />;
          break;
      }
    } else {
      starterView = (
        <EmptyNote>This one got garbled somewhere between Telegram and here. Send it again and I will redo it.</EmptyNote>
      );
    }
  }

  return (
    <div className="pt-4">
      <Link
        href="/dashboard"
        className="inline-flex min-h-[44px] items-center text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to your week
      </Link>

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          {task.course != null && task.course !== "" && <Sticker tone="card">{task.course}</Sticker>}
          {kind != null && <Sticker tone={kind.tone}>{kind.label}</Sticker>}
          {status != null && <Sticker tone={status.tone}>{status.label}</Sticker>}
        </div>
        <h1 className="mt-3 font-display text-3xl font-extrabold leading-tight md:text-4xl">
          {task.title}
        </h1>
        <p className={cn("mt-2 text-sm", due.overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
          {due.text}
        </p>
        <div className="mt-4">
          <TaskDoneToggle taskId={task.id} done={task.status === "done"} />
        </div>
      </header>

      <section aria-label="Prepared work" className="mt-8">
        {starterView}
      </section>

      <HistoryList events={events} />
    </div>
  );
}

function diagnosisAlt(firstErrorStep: number | null, isCorrect: boolean): string {
  if (isCorrect) return "Photo of your math working";
  if (firstErrorStep == null) return "Photo of your math working";
  return `Photo of your math working with step ${firstErrorStep} circled`;
}
