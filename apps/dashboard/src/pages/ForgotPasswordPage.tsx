import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { BRAND_NAME } from "@/brand";
import { TurnstileField } from "@/components/auth/TurnstileField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/forgot-password", {
        method: "POST",
        json: { email, turnstileToken },
        token: null,
        skipAuthRefresh: true,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <header>
        <p className="font-display text-4xl tracking-tight">{BRAND_NAME}</p>
        <p className="mt-2 text-muted">Reset your password.</p>
      </header>
      {done ? (
        <p className="text-muted">
          If that email exists, we sent a reset link.{" "}
          <Link className="text-accent underline" to="/login">Back to sign in</Link>
        </p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 border border-line bg-panel p-5">
          <div className="grid gap-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <TurnstileField onToken={setTurnstileToken} />
          {error ? <p className="text-sm text-warn" role="alert">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </div>
  );
}
