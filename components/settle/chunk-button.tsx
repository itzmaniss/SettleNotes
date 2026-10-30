import { Button, type ButtonProps } from "@/components/ui/button"

export type ChunkButtonProps = Omit<ButtonProps, "variant">

export function ChunkButton({ tone = "accent", ...props }: ChunkButtonProps) {
  return <Button variant="chunk" tone={tone} {...props} />
}
