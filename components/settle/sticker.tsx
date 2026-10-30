import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

export const stickerVariants = cva(
  "inline-flex items-center rounded-full border-2 border-border px-2.5 py-0.5 font-display text-[11px] font-bold",
  {
    variants: {
      tone: {
        card: "bg-card text-foreground",
        accent: "bg-accent text-accent-foreground",
        pop: "bg-pop-soft text-foreground",
        destructive: "bg-destructive text-white",
        ink: "bg-foreground text-background",
      },
    },
    defaultVariants: {
      tone: "card",
    },
  }
)

export type StickerProps = React.ComponentProps<"span"> &
  VariantProps<typeof stickerVariants> & { tilt?: number }

export function Sticker({ tone, tilt, className, ...props }: StickerProps) {
  const rotation = tilt === undefined ? null : Math.max(-6, Math.min(6, tilt))
  return (
    <span
      style={rotation === null ? undefined : { transform: `rotate(${rotation}deg)` }}
      className={cn(stickerVariants({ tone }), className)}
      {...props}
    />
  )
}
