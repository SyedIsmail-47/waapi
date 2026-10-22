import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BRAND_NAME } from "@/brand";
import { TurnstileField } from "@/components/auth/TurnstileField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

type SignupMode = "open" | "invite" | "closed";

export function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [mode, setMode] = useState<SignupMode | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ mode: SignupMode }>("/api/v1/auth/signup-config", {
      method: "GET",
      token: null,
      skipAuthRefresh: true,
    })
      .then((cfg) => setMode(cfg.mode))
      .catch(() => setMode("invite"));
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/register", {
        method: "POST",
        json: {
          email,
          password,
          name: name || undefined,
          inviteCode: mode === "invite" ? inviteCode : undefined,
          turnstileToken,
        },
        token: null,
        skipAuthRefresh: true,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Signup failed");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
        <p className="font-display text-3xl">{BRAND_NAME}</p>
        <p className="text-muted">
          Check your email for a verification link, then{" "}
          <Link className="text-accent underline" to="/login">sign in</Link>.
        </p>
      </div>
    );
  }

  if (mode === "closed") {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
        <p className="font-display text-3xl">{BRAND_NAME}</p>
        <p className="text-muted">
          Signups are closed. If you already have an account,{" "}
          <Link className="text-accent underline" to="/login">sign in</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <header>
        <p className="font-display text-4xl tracking-tight">{BRAND_NAME}</p>
        <p className="mt-2 text-muted">
          {mode === "invite" ? "Create an account with your invite code." : "Create an account."}
        </p>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 border border-line bg-panel p-5">
        {mode === "invite" ? (
          <div className="grid gap-1">
            <Label htmlFor="invite">Invite code</Label>
            <Input
              id="invite"
              data-testid="invite-code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
        ) : null}
        <div className="grid gap-1">
          <Label htmlFor="name">Name (optional)</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="password">Password (min 10)</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <TurnstileField onToken={setTurnstileToken} />
        {error ? <p className="text-sm text-warn" role="alert">{error}</p> : null}
        <Button type="submit" disabled={busy || mode == null}>
          {busy ? "Creating…" : "Sign up"}
        </Button>
      </form>
      <p className="text-sm text-muted">
        Already have an account? <Link className="text-accent underline" to="/login">Sign in</Link>
      </p>
    </div>
  );
}
