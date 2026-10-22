import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-line bg-accent-soft text-ink",
        success: "border-transparent bg-[#d8f3e4] text-[#0f5c38] dark:bg-[#143528] dark:text-[#8fd4b0]",
        warn: "border-transparent bg-[#fff1db] text-warn dark:bg-[#3a2a12] dark:text-[#f0c48a]",
        danger: "border-transparent bg-[#fde8e6] text-[#b42318] dark:bg-[#3a1614] dark:text-[#f2a8a0]",
        muted: "border-line bg-panel text-muted",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
