import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback/states";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

type SessionRow = { id: string; name: string };
type MessageRow = {
  id: string;
  sessionId: string;
  direction?: string;
  remoteJid: string | null;
  messageType: string | null;
  fromMe: boolean | null;
  error: string | null;
  createdAt: string;
};

export function MessagesPage() {
  const [sessionId, setSessionId] = useState("");
  const [direction, setDirection] = useState("all");

  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<SessionRow[]>("/api/v1/sessions"),
  });

  const messages = useQuery({
    queryKey: ["messages", sessionId],
    queryFn: () => {
      const q = new URLSearchParams({ limit: "50" });
      if (sessionId) q.set("sessionId", sessionId);
      return api<{ items: MessageRow[] }>(`/api/v1/messages?${q}`);
    },
  });

  const filtered = useMemo(() => {
    const items = messages.data?.items ?? [];
    if (direction === "all") return items;
    return items.filter((m) => {
      const dir = m.direction ?? (m.fromMe ? "outbound" : "inbound");
      return dir === direction;
    });
  }, [messages.data, direction]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="font-display text-3xl text-ink">Message log</h1>
        <p className="text-sm text-muted">Metadata only — message bodies are not stored by default.</p>
      </header>

      <div className="flex flex-wrap gap-4 border border-line bg-panel p-4">
        <div className="grid gap-1">
          <Label htmlFor="filter-session">Session</Label>
          <select
            id="filter-session"
            className="h-10 border border-line bg-panel px-3 text-sm"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          >
            <option value="">All sessions</option>
            {sessions.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="filter-direction">Direction</Label>
          <select
            id="filter-direction"
            className="h-10 border border-line bg-panel px-3 text-sm"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          >
            <option value="all">All</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </div>
      </div>

      {messages.isLoading ? <LoadingState /> : null}
      {messages.error ? (
        <ErrorState
          message={messages.error instanceof ApiError ? messages.error.message : "Load failed"}
          onRetry={() => void messages.refetch()}
        />
      ) : null}
      {!messages.isLoading && filtered.length === 0 ? (
        <EmptyState title="No messages" description="Send or receive traffic to populate this log." />
      ) : null}
      {filtered.length > 0 ? (
        <div className="overflow-x-auto border border-line bg-panel">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Session</th>
                <th className="px-3 py-2 font-medium">Remote</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {new Date(m.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{m.sessionId.slice(0, 8)}…</td>
                  <td className="px-3 py-2">{m.remoteJid ?? "—"}</td>
                  <td className="px-3 py-2">{m.messageType ?? "—"}</td>
                  <td className="px-3 py-2 text-warn">{m.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
