import { Turnstile } from "@marsidev/react-turnstile";

const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();

export function TurnstileField({
  onToken,
}: {
  onToken: (token: string | undefined) => void;
}) {
  if (!siteKey) {
    return (
      <p className="text-xs text-muted" data-testid="turnstile-skipped">
        Turnstile disabled (no site key).
      </p>
    );
  }
  return (
    <Turnstile
      siteKey={siteKey}
      onSuccess={(token) => onToken(token)}
      onExpire={() => onToken(undefined)}
      onError={() => onToken(undefined)}
      options={{ theme: "auto" }}
    />
  );
}
