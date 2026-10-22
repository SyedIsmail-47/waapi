import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { BRAND_NAME } from "@/brand";
import { TurnstileField } from "@/components/auth/TurnstileField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

export function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/register", {
        method: "POST",
        json: { email, password, name: name || undefined, turnstileToken },
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

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <header>
        <p className="font-display text-4xl tracking-tight">{BRAND_NAME}</p>
        <p className="mt-2 text-muted">Create an account.</p>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 border border-line bg-panel p-5">
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
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Sign up"}
        </Button>
      </form>
      <p className="text-sm text-muted">
        Already have an account? <Link className="text-accent underline" to="/login">Sign in</Link>
      </p>
    </div>
  );
}
