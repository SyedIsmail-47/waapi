import { Badge } from "@/components/ui/badge";

const MAP: Record<string, { label: string; variant: "success" | "warn" | "danger" | "muted" | "default" }> = {
  connected: { label: "Connected", variant: "success" },
  connecting: { label: "Connecting", variant: "warn" },
  need_scan: { label: "Need scan", variant: "warn" },
  disconnected: { label: "Disconnected", variant: "muted" },
  logged_out: { label: "Logged out", variant: "muted" },
  error: { label: "Error", variant: "danger" },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = MAP[status] ?? { label: status, variant: "default" as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
