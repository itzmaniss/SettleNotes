"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import type { CheckboxRootProps } from "@base-ui/react/checkbox"
import { Check as CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type CheckProps = CheckboxRootProps & { label?: string }

export function Check({ label, className, ...props }: CheckProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="check"
      {...props}
      {...(label === undefined ? null : { "aria-label": label })}
      className={cn(
        "relative grid size-6 shrink-0 cursor-pointer place-items-center rounded-[8px] border-2 border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 data-checked:bg-accent",
        // Invisible halo: keeps the tap target at 44px without changing the
        // 24px visual (rounded-md would resolve to 1rem at radius 1.25rem,
        // so the corner radius is a literal to stay a rounded square).
        "before:absolute before:inset-[-10px] before:content-['']",
        className
      )}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center text-foreground">
        <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
