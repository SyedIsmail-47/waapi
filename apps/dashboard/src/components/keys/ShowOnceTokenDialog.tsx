import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ShowOnceTokenDialog({
  open,
  onOpenChange,
  title,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  token: string | null;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Copy this token now. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <code className="block break-all border border-line bg-paper p-3 font-mono text-xs text-ink">
          {token}
        </code>
        <div className="flex gap-2">
          <Button type="button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
