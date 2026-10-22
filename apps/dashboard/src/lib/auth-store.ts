type Listener = (accessToken: string | null) => void;

const CHANNEL = "waapi-auth-access";

let accessToken: string | null = null;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  channel ??= new BroadcastChannel(CHANNEL);
  return channel;
}

function emit(next: string | null) {
  for (const listener of listeners) listener(next);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null, broadcast = true): void {
  accessToken = token;
  emit(token);
  if (broadcast) {
    getChannel()?.postMessage({ type: "access", token });
  }
}

export function clearAccessToken(broadcast = true): void {
  setAccessToken(null, broadcast);
}

export function subscribeAccessToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initAuthBroadcast(): () => void {
  const ch = getChannel();
  if (!ch) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; token?: string | null };
    if (data?.type === "access") {
      setAccessToken(data.token ?? null, false);
    }
  };
  ch.addEventListener("message", onMessage);
  return () => ch.removeEventListener("message", onMessage);
}
