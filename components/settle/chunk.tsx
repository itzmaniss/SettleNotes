import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

export const chunkVariants = cva(
  "rounded-[var(--radius)] border-2 border-border shadow-[4px_4px_0_0_var(--foreground)]",
  {
    variants: {
      // The background lives only here, never in the base, so the chosen tone
      // always wins: cva emits variant classes after the base and cn (twMerge)
      // keeps the last conflicting class. The mock instead painted bg-card
      // into the base class, which needed !important to escape.
      tone: {
        card: "bg-card text-foreground",
        accent: "bg-accent text-accent-foreground",
        pop: "bg-pop-soft text-foreground",
        ink: "bg-foreground text-background",
      },
    },
    defaultVariants: {
      tone: "card",
    },
  }
)

export type ChunkProps = React.ComponentProps<"div"> &
  VariantProps<typeof chunkVariants>

export function Chunk({ tone, className, ...props }: ChunkProps) {
  return <div className={cn(chunkVariants({ tone }), className)} {...props} />
}
