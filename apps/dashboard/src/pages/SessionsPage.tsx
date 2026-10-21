import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback/states";
import { StatusBadge } from "@/components/sessions/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

type SessionRow = {
  id: string;
  name: string;
  status: string;
  phoneNumber: string | null;
};

export function SessionsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<SessionRow[]>("/api/v1/sessions"),
  });

  const create = useMutation({
    mutationFn: (sessionName: string) =>
      api<SessionRow>("/api/v1/sessions", {
        method: "POST",
        json: { name: sessionName },
      }),
    onSuccess: async () => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-3xl text-ink">Sessions</h1>
        <p className="text-sm text-muted">Connected WhatsApp numbers for your account.</p>
      </header>

      <form
        className="flex flex-wrap items-end gap-3 border border-line bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const value = name.trim() || `phone-${Date.now().toString().slice(-4)}`;
          create.mutate(value);
        }}
      >
        <div className="grid min-w-[12rem] flex-1 gap-1">
          <Label htmlFor="session-name">New session name</Label>
          <Input
            id="session-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="office-phone"
          />
        </div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create session"}
        </Button>
      </form>
      {create.error ? (
        <ErrorState
          message={create.error instanceof ApiError ? create.error.message : "Create failed"}
        />
      ) : null}

      {sessions.isLoading ? <LoadingState /> : null}
      {sessions.error ? (
        <ErrorState
          message={sessions.error instanceof ApiError ? sessions.error.message : "Load failed"}
          onRetry={() => void sessions.refetch()}
        />
      ) : null}
      {sessions.data?.length === 0 ? (
        <EmptyState title="No sessions yet" description="Create a session to link a WhatsApp number." />
      ) : null}
      {sessions.data && sessions.data.length > 0 ? (
        <ul className="divide-y divide-line border border-line bg-panel">
          {sessions.data.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <Link className="font-medium text-ink hover:underline" to={`/sessions/${row.id}`}>
                  {row.name}
                </Link>
                <p className="text-xs text-muted">
                  {row.phoneNumber ?? "No phone yet"} · {row.id.slice(0, 8)}…
                </p>
              </div>
              <StatusBadge status={row.status} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
