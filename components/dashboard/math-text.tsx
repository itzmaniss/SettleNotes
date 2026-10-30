import { Tex } from "@/components/settle";

// The schema calls it latex_or_text: render anything with latex markers
// through KaTeX (throwOnError: false falls back to the raw text) and plain
// sentences as plain text, since KaTeX collapses ordinary word spacing.
const LATEX_HINT = /[\\^_]|\{|\}/;

export function MathText({ text }: { text: string }) {
  if (LATEX_HINT.test(text)) return <Tex tex={text} />;
  return <span>{text}</span>;
}
