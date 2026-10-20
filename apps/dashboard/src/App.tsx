import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { BRAND_NAME_FALLBACK } from "@waapi/shared";

type Tokens = { accessToken: string; refreshToken: string };
type SessionRow = {
  id: string;
  name: string;
  status: string;
  phoneNumber: string | null;
};
type SessionStatus = {
  id: string;
  status: string;
  phoneNumber: string | null;
  lastError: string | null;
  qr: { value: string; updatedAt: string; expiresAt: string } | null;
  qrExpired?: boolean;
};

const STORAGE_KEY = "waapi.live.tokens";

async function api<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (body as { error?: { message?: string } })?.error?.message ??
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

export function App() {
  const [email, setEmail] = useState("live-1907371620@example.com");
  const [password, setPassword] = useState("correct-horse-battery-staple");
  const [tokens, setTokens] = useState<Tokens | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Tokens) : null;
    } catch {
      return null;
    }
  });
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persist = useCallback((next: Tokens | null) => {
    setTokens(next);
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const refreshSessions = useCallback(async (accessToken: string) => {
    const rows = await api<SessionRow[]>("/api/v1/sessions", { token: accessToken });
    setSessions(rows);
    if (!sessionId && rows[0]) setSessionId(rows[0].id);
  }, [sessionId]);

  const login = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await api<Tokens>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      persist(next);
      await refreshSessions(next.accessToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createSession = async () => {
    if (!tokens) return;
    setBusy(true);
    setError(null);
    try {
      const row = await api<SessionRow>("/api/v1/sessions", {
        method: "POST",
        token: tokens.accessToken,
        body: JSON.stringify({ name: `phone-${Date.now().toString().slice(-4)}` }),
      });
      setSessionId(row.id);
      await refreshSessions(tokens.accessToken);
      await api(`/api/v1/sessions/${row.id}/connect`, {
        method: "POST",
        token: tokens.accessToken,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async () => {
    if (!tokens || !sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/sessions/${sessionId}/connect`, {
        method: "POST",
        token: tokens.accessToken,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!tokens) return;
    void refreshSessions(tokens.accessToken).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [tokens, refreshSessions]);

  useEffect(() => {
    if (!tokens || !sessionId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await api<SessionStatus>(
          `/api/v1/sessions/${sessionId}/status`,
          { token: tokens.accessToken },
        );
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [tokens, sessionId]);

  const connected = status?.status === "connected";
  const qrValue = useMemo(() => {
    if (!status?.qr?.value || status.qrExpired) return null;
    if (new Date(status.qr.expiresAt) <= new Date()) return null;
    return status.qr.value;
  }, [status]);

  return (
    <main className="min-h-screen px-4 py-10 sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="space-y-2">
          <p className="display text-4xl tracking-tight sm:text-5xl">{BRAND_NAME_FALLBACK}</p>
          <p className="max-w-xl text-[var(--muted)]">
            Link a WhatsApp number: sign in, open a session, then scan the QR with WhatsApp → Linked devices.
          </p>
        </header>

        {!tokens ? (
          <form
            onSubmit={login}
            className="grid gap-3 rounded-none border border-[var(--line)] bg-[var(--panel)] p-5 shadow-none sm:grid-cols-[1fr_1fr_auto]"
          >
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--muted)]">Email</span>
              <input
                className="border border-[var(--line)] bg-white px-3 py-2 outline-none focus:border-[var(--accent)]"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-[var(--muted)]">Password</span>
              <input
                type="password"
                className="border border-[var(--line)] bg-white px-3 py-2 outline-none focus:border-[var(--accent)]"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="self-end bg-[var(--ink)] px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <section className="flex flex-wrap items-end gap-3 border border-[var(--line)] bg-[var(--panel)] p-5">
            <label className="grid min-w-[16rem] flex-1 gap-1 text-sm">
              <span className="text-[var(--muted)]">Session</span>
              <select
                className="border border-[var(--line)] bg-white px-3 py-2"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              >
                {sessions.length === 0 ? <option value="">No sessions yet</option> : null}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.status}
                    {s.phoneNumber ? ` · ${s.phoneNumber}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void createSession()}
              className="bg-[var(--accent)] px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              New session
            </button>
            <button
              type="button"
              disabled={busy || !sessionId}
              onClick={() => void reconnect()}
              className="border border-[var(--line)] bg-white px-4 py-2 font-medium disabled:opacity-50"
            >
              Refresh QR
            </button>
            <button
              type="button"
              onClick={() => {
                persist(null);
                setSessions([]);
                setSessionId("");
                setStatus(null);
              }}
              className="border border-[var(--line)] bg-white px-4 py-2 text-[var(--muted)]"
            >
              Sign out
            </button>
          </section>
        )}

        {error ? (
          <p className="border border-[#e8c9a8] bg-[#fff7ee] px-4 py-3 text-sm text-[var(--warn)]">
            {error}
          </p>
        ) : null}

        <section className="grid gap-6 border border-[var(--line)] bg-[var(--panel)] p-6 sm:grid-cols-[280px_1fr]">
          <div className="flex items-center justify-center bg-[var(--accent-soft)] p-4">
            {connected ? (
              <div className="text-center">
                <p className="display text-3xl text-[var(--accent)]">Connected</p>
                <p className="mt-2 text-sm text-[var(--muted)]">{status?.phoneNumber}</p>
              </div>
            ) : qrValue ? (
              <div className="bg-white p-3">
                <QRCodeSVG value={qrValue} size={240} level="M" includeMargin />
              </div>
            ) : (
              <p className="max-w-[14rem] text-center text-sm text-[var(--muted)]">
                {tokens
                  ? sessionId
                    ? "Waiting for QR… use Refresh QR if it stays empty."
                    : "Create or select a session to show a QR code."
                  : "Sign in to start linking."}
              </p>
            )}
          </div>

          <div className="space-y-4">
            <h2 className="display text-2xl">Scan to connect</h2>
            <ol className="list-decimal space-y-2 pl-5 text-[var(--muted)]">
              <li>Open WhatsApp on your phone</li>
              <li>Settings → Linked devices → Link a device</li>
              <li>Point the camera at this QR code</li>
            </ol>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-[var(--muted)]">Status</dt>
              <dd className="font-medium">{status?.status ?? "—"}</dd>
              <dt className="text-[var(--muted)]">Session</dt>
              <dd className="truncate font-mono text-xs">{sessionId || "—"}</dd>
              <dt className="text-[var(--muted)]">QR expires</dt>
              <dd>{status?.qr?.expiresAt ? new Date(status.qr.expiresAt).toLocaleTimeString() : "—"}</dd>
              {status?.lastError ? (
                <>
                  <dt className="text-[var(--muted)]">Last error</dt>
                  <dd className="text-[var(--warn)]">{status.lastError}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </section>
      </div>
    </main>
  );
}
