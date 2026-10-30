"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"

export function nextFlipState(current: boolean): boolean {
  return !current
}

export type FlipCardProps = {
  front: React.ReactNode
  back: React.ReactNode
  className?: string
  defaultFlipped?: boolean
  onFlip?: (flipped: boolean) => void
}

const faceClass =
  "absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-[var(--radius)] border-2 border-border p-4 text-center [backface-visibility:hidden]"

export function FlipCard({
  front,
  back,
  className,
  defaultFlipped = false,
  onFlip,
}: FlipCardProps) {
  const [flipped, setFlipped] = useState(defaultFlipped)

  const toggle = () => {
    const next = nextFlipState(flipped)
    setFlipped(next)
    onFlip?.(next)
  }

  return (
    <button
      type="button"
      aria-pressed={flipped}
      onClick={toggle}
      className={cn(
        "block h-40 w-full cursor-pointer rounded-[var(--radius)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [perspective:1200px]",
        className
      )}
    >
      <span
        className={cn(
          "relative block h-full transition-transform duration-500 ease-[cubic-bezier(.3,1.4,.5,1)] [transform-style:preserve-3d] motion-reduce:transition-none",
          flipped && "[transform:rotateY(180deg)]"
        )}
      >
        <span
          aria-hidden={flipped || undefined}
          inert={flipped || undefined}
          className={cn(faceClass, "bg-card text-foreground")}
        >
          {front}
        </span>
        <span
          aria-hidden={!flipped || undefined}
          inert={!flipped || undefined}
          className={cn(faceClass, "bg-pop-soft text-foreground [transform:rotateY(180deg)]")}
        >
          {back}
        </span>
      </span>
    </button>
  )
}
