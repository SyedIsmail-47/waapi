import { FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingState } from "@/components/feedback/states";
import { ShowOnceTokenDialog } from "@/components/keys/ShowOnceTokenDialog";
import { QrModal } from "@/components/sessions/QrModal";
import { StatusBadge } from "@/components/sessions/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api-client";

type Session = {
  id: string;
  name: string;
  status: string;
  phoneNumber: string | null;
};

type KeyRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type Webhook = {
  id: string;
  url: string;
  enabled: boolean;
};

type Delivery = {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  lastError: string | null;
  responseCode: number | null;
  createdAt: string;
};

export function SessionDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [qrOpen, setQrOpen] = useState(false);
  const [onceToken, setOnceToken] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("default");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(true);

  const session = useQuery({
    queryKey: ["session", id],
    enabled: Boolean(id),
    queryFn: () => api<Session>(`/api/v1/sessions/${id}`),
  });

  const keys = useQuery({
    queryKey: ["session-keys", id],
    enabled: Boolean(id),
    queryFn: () => api<KeyRow[]>(`/api/v1/sessions/${id}/keys`),
  });

  const webhook = useQuery({
    queryKey: ["webhook", id],
    enabled: Boolean(id),
    queryFn: async () => {
      try {
        return await api<Webhook>(`/api/v1/sessions/${id}/webhook`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", id],
    enabled: Boolean(id) && Boolean(webhook.data),
    queryFn: () =>
      api<{ items: Delivery[] }>(`/api/v1/sessions/${id}/webhook/deliveries?limit=30`),
  });

  const createKey = useMutation({
    mutationFn: (name: string) =>
      api<{ token: string }>(`/api/v1/sessions/${id}/keys`, {
        method: "POST",
        json: { name },
      }),
    onSuccess: async (body) => {
      setOnceToken(body.token);
      await queryClient.invalidateQueries({ queryKey: ["session-keys", id] });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (keyId: string) =>
      api(`/api/v1/sessions/${id}/keys/${keyId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session-keys", id] });
    },
  });

  const saveWebhook = useMutation({
    mutationFn: () =>
      api(`/api/v1/sessions/${id}/webhook`, {
        method: "PUT",
        json: {
          url: webhookUrl || webhook.data?.url,
          secret: webhookSecret || undefined,
          enabled: webhookEnabled,
        },
      }),
    onSuccess: async () => {
      setWebhookSecret("");
      await queryClient.invalidateQueries({ queryKey: ["webhook", id] });
    },
  });

  const testWebhook = useMutation({
    mutationFn: () => api(`/api/v1/sessions/${id}/webhook/test`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["webhook-deliveries", id] });
    },
  });

  const connect = async () => {
    await api(`/api/v1/sessions/${id}/connect`, { method: "POST" });
    setQrOpen(true);
  };

  if (session.isLoading) return <LoadingState />;
  if (session.error) {
    return (
      <ErrorState
        message={session.error instanceof ApiError ? session.error.message : "Not found"}
      />
    );
  }
  if (!session.data) return <EmptyState title="Session not found" />;

  const wh = webhook.data;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <Link className="text-sm text-accent underline" to="/sessions">
          ← Sessions
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl text-ink">{session.data.name}</h1>
          <StatusBadge status={session.data.status} />
        </div>
        <p className="text-sm text-muted">{session.data.phoneNumber ?? "No phone yet"}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={() => void connect()}>
            Connect / show QR
          </Button>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="font-display text-xl">Session API keys</h2>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createKey.mutate(keyName.trim() || "default");
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          </div>
          <Button type="submit" disabled={createKey.isPending}>
            Create key
          </Button>
        </form>
        {keys.isLoading ? <LoadingState /> : null}
        {keys.data?.length === 0 ? (
          <EmptyState title="No keys" description="Create a session key for send/status APIs." />
        ) : null}
        <ul className="divide-y divide-line border border-line bg-panel">
          {keys.data?.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className="font-medium">{key.name}</p>
                <p className="font-mono text-xs text-muted">{key.tokenPrefix}…</p>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => revokeKey.mutate(key.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-xl">Webhook</h2>
        <form
          className="grid gap-3 border border-line bg-panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveWebhook.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="webhook-url">URL</Label>
            <Input
              id="webhook-url"
              type="url"
              required
              defaultValue={wh?.url}
              value={webhookUrl || wh?.url || ""}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://example.com/hooks/waapi"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="webhook-secret">Secret (leave blank to keep)</Label>
            <Input
              id="webhook-secret"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={webhookEnabled}
              onCheckedChange={setWebhookEnabled}
              id="webhook-enabled"
            />
            <Label htmlFor="webhook-enabled">Enabled</Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saveWebhook.isPending}>
              Save webhook
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!wh || testWebhook.isPending}
              onClick={() => testWebhook.mutate()}
            >
              Send test
            </Button>
          </div>
          {saveWebhook.error || testWebhook.error ? (
            <ErrorState
              message={
                (saveWebhook.error || testWebhook.error) instanceof ApiError
                  ? ((saveWebhook.error || testWebhook.error) as ApiError).message
                  : "Webhook action failed"
              }
            />
          ) : null}
        </form>

        <h3 className="text-sm font-medium text-ink">Delivery log</h3>
        {deliveries.isLoading ? <LoadingState /> : null}
        {deliveries.data?.items.length === 0 ? (
          <EmptyState title="No deliveries yet" />
        ) : null}
        <ul className="divide-y divide-line border border-line bg-panel text-sm">
          {deliveries.data?.items.map((d) => (
            <li key={d.id} className="px-4 py-3">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">{d.eventType}</span>
                <StatusBadge status={d.status} />
              </div>
              <p className="text-xs text-muted">
                attempts {d.attempts}
                {d.responseCode != null ? ` · HTTP ${d.responseCode}` : ""}
                {" · "}
                {new Date(d.createdAt).toLocaleString()}
              </p>
              {d.lastError ? <p className="text-xs text-warn">{d.lastError}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <QrModal open={qrOpen} onOpenChange={setQrOpen} sessionId={id} />
      <ShowOnceTokenDialog
        open={Boolean(onceToken)}
        onOpenChange={(open) => {
          if (!open) setOnceToken(null);
        }}
        title="Session API key"
        token={onceToken}
      />
    </div>
  );
}
