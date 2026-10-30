import { Chunk } from "@/components/settle";

// Calm empty-state note, same Chunk language as the rest of the dashboard.
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <Chunk tone="card" className="p-5">
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
    </Chunk>
  );
}
