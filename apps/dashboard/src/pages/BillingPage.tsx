import { useMutation, useQuery } from "@tanstack/react-query";
import { ErrorState, LoadingState } from "@/components/feedback/states";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";

type BillingSnapshot = {
  planCode: string;
  planName: string;
  status: string;
  maxSessions: number;
  sendsPerDay: number;
  trialEndsAt: string | null;
  graceUntil: string | null;
  contactToUpgrade: boolean;
};

export function BillingPage() {
  const billing = useQuery({
    queryKey: ["billing"],
    queryFn: () => api<BillingSnapshot>("/api/v1/billing"),
  });

  const checkout = useMutation({
    mutationFn: (planCode: "starter" | "pro") =>
      api<{ url: string | null; contactSupport: boolean; message?: string }>(
        "/api/v1/billing/checkout",
        { method: "POST", json: { planCode } },
      ),
    onSuccess: (body) => {
      if (body.url) {
        window.location.href = body.url;
      }
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="font-display text-3xl text-ink">Billing</h1>
        <p className="text-sm text-muted">Plan, trial, and upgrades. We never store card data.</p>
      </header>

      {billing.isLoading ? <LoadingState /> : null}
      {billing.error ? (
        <ErrorState
          message={billing.error instanceof ApiError ? billing.error.message : "Failed to load"}
          onRetry={() => void billing.refetch()}
        />
      ) : null}

      {billing.data ? (
        <dl className="grid gap-3 border border-line bg-panel p-5 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">Plan</dt>
          <dd className="font-medium">{billing.data.planName}</dd>
          <dt className="text-muted">Status</dt>
          <dd>{billing.data.status}</dd>
          <dt className="text-muted">Sessions</dt>
          <dd>Up to {billing.data.maxSessions}</dd>
          <dt className="text-muted">Sends / day</dt>
          <dd>{billing.data.sendsPerDay}</dd>
          {billing.data.trialEndsAt ? (
            <>
              <dt className="text-muted">Trial ends</dt>
              <dd>{new Date(billing.data.trialEndsAt).toLocaleString()}</dd>
            </>
          ) : null}
          {billing.data.graceUntil ? (
            <>
              <dt className="text-muted">Grace until</dt>
              <dd>{new Date(billing.data.graceUntil).toLocaleString()}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <div className="space-y-3 border border-line bg-panel p-5">
        <p className="font-medium">Upgrade</p>
        {billing.data?.contactToUpgrade || checkout.data?.contactSupport ? (
          <p className="text-sm text-muted">
            Contact support to upgrade. Card checkout is not collected in this dashboard.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={checkout.isPending}
            onClick={() => checkout.mutate("starter")}
          >
            Upgrade to Starter
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={checkout.isPending}
            onClick={() => checkout.mutate("pro")}
          >
            Upgrade to Pro
          </Button>
        </div>
        {checkout.error ? (
          <p className="text-sm text-warn" role="alert">
            {checkout.error instanceof ApiError ? checkout.error.message : "Checkout failed"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
