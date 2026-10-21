import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BRAND_NAME } from "@/brand";
import { TurnstileField } from "@/components/auth/TurnstileField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, loginRequest } from "@/lib/api-client";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginRequest(email, password, turnstileToken);
      navigate("/sessions", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <header>
        <p className="font-display text-4xl tracking-tight">{BRAND_NAME}</p>
        <p className="mt-2 text-muted">Sign in to manage WhatsApp sessions.</p>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 border border-line bg-panel p-5">
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
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <TurnstileField onToken={setTurnstileToken} />
        {error ? <p className="text-sm text-warn" role="alert">{error}</p> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="text-sm text-muted">
        No account? <Link className="text-accent underline" to="/signup">Sign up</Link>
        {" · "}
        <Link className="text-accent underline" to="/forgot-password">Forgot password</Link>
      </p>
    </div>
  );
}
