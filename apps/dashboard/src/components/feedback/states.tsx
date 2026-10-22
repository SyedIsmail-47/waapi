import { Button } from "@/components/ui/button";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="text-sm text-muted" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="border border-line bg-panel p-8 text-center">
      <p className="font-display text-lg text-ink">{title}</p>
      {description ? <p className="mt-2 text-sm text-muted">{description}</p> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-[#e8c9a8] bg-[#fff7ee] p-4 text-sm text-warn dark:border-[#5a3d1a] dark:bg-[#2a1f10]" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
