import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "@/components/feedback/states";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, logoutRequest } from "@/lib/api-client";

type Me = {
  userId: string;
  accountId: string;
  email: string;
  emailVerifiedAt: string | null;
  role: string;
  accountName: string;
};

export function SettingsPage() {
  const navigate = useNavigate();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/api/v1/auth/me"),
  });

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    await logoutRequest();
    navigate("/login", { replace: true });
  };

  const logoutAll = async () => {
    await api("/api/v1/auth/logout-all", { method: "POST" });
    await logoutRequest();
    navigate("/login", { replace: true });
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api("/api/v1/auth/change-password", {
        method: "POST",
        json: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setMsg("Password updated. Other devices were signed out.");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not change password");
    } finally {
      setBusy(false);
    }
  };

  const resendVerify = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api("/api/v1/auth/resend-verification", { method: "POST", json: {} });
      setMsg("Verification email sent if the address is still unverified.");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not resend");
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/v1/auth/delete-account", {
        method: "POST",
        json: { password: deletePassword },
      });
      await logoutRequest();
      navigate("/login", { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not delete account");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="font-display text-3xl text-ink">Settings</h1>
        <p className="text-sm text-muted">Account and appearance.</p>
      </header>

      {me.isLoading ? <LoadingState /> : null}
      {me.error ? (
        <ErrorState
          message={me.error instanceof ApiError ? me.error.message : "Failed to load profile"}
          onRetry={() => void me.refetch()}
        />
      ) : null}

      {me.data ? (
        <dl className="grid gap-3 border border-line bg-panel p-5 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted">Account</dt>
          <dd className="font-medium">{me.data.accountName}</dd>
          <dt className="text-muted">Email</dt>
          <dd>{me.data.email}</dd>
          <dt className="text-muted">Verified</dt>
          <dd>{me.data.emailVerifiedAt ? "Yes" : "No"}</dd>
          <dt className="text-muted">Role</dt>
          <dd>{me.data.role}</dd>
        </dl>
      ) : null}

      {me.data && !me.data.emailVerifiedAt ? (
        <div className="border border-line bg-panel p-4">
          <p className="text-sm text-muted">Email not verified.</p>
          <Button type="button" className="mt-2" disabled={busy} onClick={() => void resendVerify()}>
            Resend verification
          </Button>
        </div>
      ) : null}

      <form onSubmit={(e) => void changePassword(e)} className="grid gap-3 border border-line bg-panel p-5">
        <p className="font-medium">Change password</p>
        <div className="grid gap-1">
          <Label htmlFor="current-pw">Current password</Label>
          <Input
            id="current-pw"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="new-pw">New password (min 10)</Label>
          <Input
            id="new-pw"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={busy}>
          Update password
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-3 border border-line bg-panel p-4">
        <span className="text-sm text-muted">Theme</span>
        <ThemeToggle />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => void logout()}>
          Sign out
        </Button>
        <Button type="button" variant="destructive" onClick={() => void logoutAll()}>
          Sign out all devices
        </Button>
      </div>

      <form
        onSubmit={(e) => void deleteAccount(e)}
        className="grid gap-3 border border-warn/40 bg-panel p-5"
      >
        <p className="font-medium text-warn">Delete account</p>
        <p className="text-sm text-muted">
          Logs out every WhatsApp session, wipes auth state, revokes keys and webhooks, and deletes
          message logs. This cannot be undone.
        </p>
        {!confirmDelete ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
            Delete my account…
          </Button>
        ) : (
          <>
            <div className="grid gap-1">
              <Label htmlFor="del-pw">Confirm with password</Label>
              <Input
                id="del-pw"
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="destructive" disabled={busy}>
                Permanently delete
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setConfirmDelete(false);
                  setDeletePassword("");
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        )}
      </form>

      {msg ? <p className="text-sm text-muted">{msg}</p> : null}
      {err ? (
        <p className="text-sm text-warn" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
