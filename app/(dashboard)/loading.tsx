import { Chunk } from "@/components/settle";

// Skeleton of the dashboard layout while the server components load.
export default function DashboardLoading() {
  return (
    <div aria-hidden="true" className="pt-4">
      <div className="grid gap-8 md:grid-cols-[1.3fr_1fr] md:gap-10">
        <div>
          <div className="h-3 w-16 animate-pulse rounded-full bg-muted" />
          <Chunk className="mt-3 p-6 md:p-7">
            <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
            <div className="mt-5 h-10 w-3/4 animate-pulse rounded-full bg-muted" />
            <div className="mt-4 h-4 w-1/2 animate-pulse rounded-full bg-muted" />
            <div className="mt-7 h-11 w-28 animate-pulse rounded-full bg-muted" />
          </Chunk>
          <div className="mt-10 h-3 w-20 animate-pulse rounded-full bg-muted" />
          <Chunk className="mt-3 p-4">
            <div className="flex items-center gap-4">
              <div className="size-6 animate-pulse rounded-[8px] bg-muted" />
              <div className="flex-1">
                <div className="h-4 w-2/3 animate-pulse rounded-full bg-muted" />
                <div className="mt-2 h-3 w-1/3 animate-pulse rounded-full bg-muted" />
              </div>
            </div>
          </Chunk>
          <Chunk className="mt-3 p-4">
            <div className="flex items-center gap-4">
              <div className="size-6 animate-pulse rounded-[8px] bg-muted" />
              <div className="flex-1">
                <div className="h-4 w-1/2 animate-pulse rounded-full bg-muted" />
                <div className="mt-2 h-3 w-2/5 animate-pulse rounded-full bg-muted" />
              </div>
            </div>
          </Chunk>
        </div>
        <div className="space-y-8">
          <div>
            <div className="h-3 w-24 animate-pulse rounded-full bg-muted" />
            <Chunk className="mt-3 p-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="h-4 w-2/3 animate-pulse rounded-full bg-muted" />
                  <div className="mt-2 h-3 w-1/3 animate-pulse rounded-full bg-muted" />
                </div>
                <div className="h-11 w-20 animate-pulse rounded-full bg-muted" />
              </div>
            </Chunk>
          </div>
          <div>
            <div className="h-3 w-20 animate-pulse rounded-full bg-muted" />
            <Chunk className="mt-3 p-5">
              <div className="h-4 w-1/3 animate-pulse rounded-full bg-muted" />
              <div className="mt-4 flex gap-1">
                <div className="h-2 flex-1 animate-pulse rounded-full bg-muted" />
                <div className="h-2 flex-1 animate-pulse rounded-full bg-muted" />
                <div className="h-2 flex-1 animate-pulse rounded-full bg-muted" />
              </div>
              <div className="mt-3 flex gap-1">
                <div className="h-2 flex-1 animate-pulse rounded-full bg-muted" />
                <div className="h-2 flex-1 animate-pulse rounded-full bg-muted" />
                <div className="h-2 flex-1 animate-pulse rounded-full bg-muted" />
              </div>
            </Chunk>
          </div>
        </div>
      </div>
    </div>
  );
}
