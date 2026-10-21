import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback/states";
import { ShowOnceTokenDialog } from "@/components/keys/ShowOnceTokenDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

type Pat = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  revokedAt: string | null;
};

export function PatsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [onceToken, setOnceToken] = useState<string | null>(null);

  const pats = useQuery({
    queryKey: ["pats"],
    queryFn: () => api<Pat[]>("/api/v1/auth/tokens"),
  });

  const create = useMutation({
    mutationFn: (patName: string) =>
      api<{ token: string }>("/api/v1/auth/tokens", {
        method: "POST",
        json: { name: patName },
      }),
    onSuccess: async (body) => {
      setOnceToken(body.token);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["pats"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/auth/tokens/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["pats"] });
    },
  });

  const active = pats.data?.filter((p) => !p.revokedAt) ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="font-display text-3xl text-ink">Personal access tokens</h1>
        <p className="text-sm text-muted">Account-scoped tokens for the HTTP API. Shown once on create.</p>
      </header>

      <form
        className="flex flex-wrap items-end gap-3 border border-line bg-panel p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate(name.trim() || "dashboard");
        }}
      >
        <div className="grid min-w-[12rem] flex-1 gap-1">
          <Label htmlFor="pat-name">Name</Label>
          <Input id="pat-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" disabled={create.isPending}>
          Create token
        </Button>
      </form>
      {create.error ? (
        <ErrorState
          message={create.error instanceof ApiError ? create.error.message : "Create failed"}
        />
      ) : null}

      {pats.isLoading ? <LoadingState /> : null}
      {pats.error ? (
        <ErrorState
          message={pats.error instanceof ApiError ? pats.error.message : "Load failed"}
          onRetry={() => void pats.refetch()}
        />
      ) : null}
      {active.length === 0 && !pats.isLoading ? (
        <EmptyState title="No active tokens" />
      ) : null}
      <ul className="divide-y divide-line border border-line bg-panel">
        {active.map((pat) => (
          <li key={pat.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div>
              <p className="font-medium">{pat.name}</p>
              <p className="font-mono text-xs text-muted">{pat.tokenPrefix}…</p>
            </div>
            <Button type="button" variant="destructive" size="sm" onClick={() => revoke.mutate(pat.id)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>

      <ShowOnceTokenDialog
        open={Boolean(onceToken)}
        onOpenChange={(open) => {
          if (!open) setOnceToken(null);
        }}
        title="Personal access token"
        token={onceToken}
      />
    </div>
  );
}
