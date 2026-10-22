import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BRAND_NAME } from "@/brand";
import { LoadingState } from "@/components/feedback/states";
import { api, ApiError } from "@/lib/api-client";

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("Missing verification token.");
      return;
    }
    void api("/api/v1/auth/verify-email", {
      method: "POST",
      json: { token },
      token: null,
      skipAuthRefresh: true,
    })
      .then(() => setStatus("ok"))
      .catch((err) => {
        setStatus("error");
        setMessage(err instanceof ApiError ? err.message : "Verification failed");
      });
  }, [token]);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <p className="font-display text-3xl">{BRAND_NAME}</p>
      {status === "loading" ? <LoadingState label="Verifying email…" /> : null}
      {status === "ok" ? (
        <p className="text-muted">
          Email verified. <Link className="text-accent underline" to="/login">Sign in</Link>
        </p>
      ) : null}
      {status === "error" ? <p className="text-warn" role="alert">{message}</p> : null}
    </div>
  );
}
