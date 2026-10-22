import { FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BRAND_NAME } from "@/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/auth/reset-password", {
        method: "POST",
        json: { token, password },
        token: null,
        skipAuthRefresh: true,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <p className="font-display text-4xl tracking-tight">{BRAND_NAME}</p>
      {done ? (
        <p className="text-muted">
          Password updated. <Link className="text-accent underline" to="/login">Sign in</Link>
        </p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 border border-line bg-panel p-5">
          <div className="grid gap-1">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              minLength={10}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error ? <p className="text-sm text-warn" role="alert">{error}</p> : null}
          <Button type="submit" disabled={busy || !token}>
            {busy ? "Saving…" : "Reset password"}
          </Button>
        </form>
      )}
    </div>
  );
}
