import { ChunkButton, type ChunkButtonProps } from "@/components/settle";

type BotButtonProps = {
  href: string | null;
  children: React.ReactNode;
  tone?: ChunkButtonProps["tone"];
  className?: string;
};

// One CTA for every Telegram link on the page. With no bot username configured
// it degrades to a disabled button instead of a dead https://t.me/ link.
export function BotButton({ href, children, tone, className }: BotButtonProps) {
  if (href === null) {
    return (
      <ChunkButton tone={tone} disabled className={className}>
        Bot link coming soon
      </ChunkButton>
    );
  }
  return (
    <ChunkButton
      tone={tone}
      className={className}
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
    >
      {children}
    </ChunkButton>
  );
}
