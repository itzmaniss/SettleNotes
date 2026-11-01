import { cn } from "@/lib/utils"

export type LogoProps = {
  className?: string
  size?: number
  wordmark?: boolean
}

// Inline copy of public/brand/settle-mark.svg (ink shadow, lime bubble with
// tail, ink outline, tick, lilac spark). The d strings must stay identical to
// the file; tests/brand compares them. The wordmark stays live text in the
// display font, never drawn into the SVG.
export function Logo({ className, size = 24, wordmark = false }: LogoProps) {
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 512 512"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M156 104H324A72 72 0 0 1 396 176V304A72 72 0 0 1 324 376H204L116 432L131.38 371.66A72 72 0 0 1 84 304V176A72 72 0 0 1 156 104Z"
          transform="translate(24 24)"
          fill="#12161F"
        />
        <path
          d="M156 104H324A72 72 0 0 1 396 176V304A72 72 0 0 1 324 376H204L116 432L131.38 371.66A72 72 0 0 1 84 304V176A72 72 0 0 1 156 104Z"
          fill="#C1F354"
        />
        <path
          d="M156 104H324A72 72 0 0 1 396 176V304A72 72 0 0 1 324 376H204L116 432L131.38 371.66A72 72 0 0 1 84 304V176A72 72 0 0 1 156 104Z"
          fill="none"
          stroke="#12161F"
          strokeWidth={20}
          strokeLinejoin="round"
        />
        <path
          d="M164 244L232 312L420 100"
          fill="none"
          stroke="#12161F"
          strokeWidth={56}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polygon
          points="392,60 376.3,63.4 385,77 371.4,68.3 368,84 364.6,68.3 351,77 359.7,63.4 344,60 359.7,56.6 351,43 364.6,51.7 368,36 371.4,51.7 385,43 376.3,56.6"
          fill="#B78CF2"
        />
      </svg>
      {wordmark && (
        <span className="font-display text-xl font-extrabold tracking-tight">
          Settle
        </span>
      )}
    </span>
  )
}
