import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "@/components/feedback/states";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/button";
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

  const logout = async () => {
    await logoutRequest();
    navigate("/login", { replace: true });
  };

  const logoutAll = async () => {
    await api("/api/v1/auth/logout-all", { method: "POST" });
    await logoutRequest();
    navigate("/login", { replace: true });
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
    </div>
  );
}
