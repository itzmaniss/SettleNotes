import { Tex } from "@/components/settle";

type MathSegment = { kind: "text" | "inline" | "display"; value: string };

// Split on $...$ (inline) and $$...$$ (display). An escaped \$ is a literal
// dollar and an unmatched $ is plain text, so sentences without maths come
// back as a single text run and nothing ever reaches KaTeX by accident.
export function splitMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let plain = "";
  let index = 0;
  const flush = () => {
    if (plain !== "") {
      segments.push({ kind: "text", value: plain });
      plain = "";
    }
  };
  while (index < text.length) {
    if (text[index] === "\\" && text[index + 1] === "$") {
      plain += "$";
      index += 2;
      continue;
    }
    if (text[index] === "$") {
      const display = text.startsWith("$$", index);
      const mark = display ? "$$" : "$";
      const close = text.indexOf(mark, index + mark.length);
      if (close !== -1) {
        flush();
        segments.push({ kind: display ? "display" : "inline", value: text.slice(index + mark.length, close) });
        index = close + mark.length;
        continue;
      }
    }
    plain += text[index];
    index += 1;
  }
  flush();
  return segments;
}

// Sentence text that may carry $-wrapped maths. Server-safe, no client JS:
// text runs are ordinary React children (escaped, whitespace intact) and math
// runs go through the existing Tex, which renders with throwOnError: false
// and trust: false.
export function MixedMath({ text }: { text: string }) {
  const segments = splitMathSegments(text);
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={index}>{segment.value}</span>;
        // Block wrapper keeps KaTeX's display div legal inside a <p>.
        if (segment.kind === "display") {
          return (
            <span key={index} className="block">
              <Tex tex={segment.value} display />
            </span>
          );
        }
        return <Tex key={index} tex={segment.value} />;
      })}
    </>
  );
}
