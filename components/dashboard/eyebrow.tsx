import { cn } from "@/lib/utils";

type EyebrowProps = {
  as?: "p" | "h2" | "h3";
  id?: string;
  className?: string;
  children: React.ReactNode;
};

// The mock's mono uppercase section label ('NEXT UP', 'THIS WEEK').
export function Eyebrow({ as = "p", id, className, children }: EyebrowProps) {
  const Tag = as;
  return (
    <Tag id={id} className={cn("font-mono text-xs uppercase tracking-widest text-muted-foreground", className)}>
      {children}
    </Tag>
  );
}
