import { getAccessToken, setAccessToken, clearAccessToken } from "./auth-store";
import { readCookie } from "./utils";

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type ApiOptions = RequestInit & {
  token?: string | null;
  skipAuthRefresh?: boolean;
  json?: unknown;
};

const CSRF_COOKIE = "waapi_csrf";
const CSRF_HEADER = "x-csrf-token";

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccess(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const csrf = readCookie(CSRF_COOKIE);
    const headers = new Headers({ "content-type": "application/json" });
    if (csrf) headers.set(CSRF_HEADER, csrf);
    const res = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers,
      body: "{}",
    });
    if (!res.ok) {
      clearAccessToken();
      return null;
    }
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) {
      clearAccessToken();
      return null;
    }
    setAccessToken(body.accessToken);
    return body.accessToken;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function api<T>(path: string, init: ApiOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }
  const token = init.token === undefined ? getAccessToken() : init.token;
  if (token) headers.set("authorization", `Bearer ${token}`);

  const isAuthMutating =
    path.startsWith("/api/v1/auth/refresh") ||
    path.startsWith("/api/v1/auth/logout") ||
    path.startsWith("/api/v1/auth/logout-all");
  if (isAuthMutating) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set(CSRF_HEADER, csrf);
  }

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });

  if (res.status === 401 && !init.skipAuthRefresh && !path.includes("/auth/refresh") && !path.includes("/auth/login")) {
    const next = await refreshAccess();
    if (next) {
      return api<T>(path, { ...init, token: next, skipAuthRefresh: true });
    }
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: string; requestId?: string } })?.error;
    throw new ApiError(
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.code,
      err?.requestId,
    );
  }
  return body as T;
}

export async function bootstrapSession(): Promise<string | null> {
  if (getAccessToken()) return getAccessToken();
  return refreshAccess();
}

export async function loginRequest(email: string, password: string, turnstileToken?: string) {
  const body = await api<{ accessToken: string; refreshToken?: string }>("/api/v1/auth/login", {
    method: "POST",
    json: { email, password, turnstileToken },
    skipAuthRefresh: true,
    token: null,
  });
  // Never persist refreshToken — cookie holds it; ignore body field.
  setAccessToken(body.accessToken);
  return body.accessToken;
}

export async function logoutRequest() {
  try {
    await api("/api/v1/auth/logout", { method: "POST", json: {}, skipAuthRefresh: true });
  } finally {
    clearAccessToken();
  }
}
