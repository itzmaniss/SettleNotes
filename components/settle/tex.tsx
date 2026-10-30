import { renderToString } from "katex"

export type TexProps = {
  tex: string
  display?: boolean
  className?: string
}

// The input is our own content or model output, never untrusted user HTML.
// Rendered with throwOnError: false and the default trust: false. Never enable
// trust: it would let the input emit raw HTML and arbitrary URLs.
export function Tex({ tex, display = false, className }: TexProps) {
  let html: string
  try {
    html = renderToString(tex, {
      throwOnError: false,
      displayMode: display,
      output: "htmlAndMathml",
      trust: false,
    })
  } catch {
    return display ? (
      <div className={className}>
        <code>{tex}</code>
      </div>
    ) : (
      <code className={className}>{tex}</code>
    )
  }
  if (display) {
    return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
