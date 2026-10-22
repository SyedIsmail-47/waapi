import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken, getAccessToken, setAccessToken } from "./auth-store";

describe("auth-store memory only", () => {
  beforeEach(() => {
    clearAccessToken(false);
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps access token in memory and never writes auth keys to storage", () => {
    setAccessToken("access-test-token", false);
    expect(getAccessToken()).toBe("access-test-token");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.key(i)).not.toMatch(/token|refresh|jwt/i);
    }
  });
});

describe("api-client CSRF header", () => {
  beforeEach(() => {
    clearAccessToken(false);
    vi.restoreAllMocks();
    document.cookie = "waapi_csrf=csrf-test-value; path=/";
  });

  it("sends CSRF header on refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: "new-access" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("./api-client");
    await api("/api/v1/auth/refresh", {
      method: "POST",
      json: {},
      skipAuthRefresh: true,
      token: null,
    });

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-test-value");
    expect(init.credentials).toBe("include");
  });
});
