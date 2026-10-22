import { useEffect, useState } from "react";
import { bootstrapSession } from "@/lib/api-client";
import {
  getAccessToken,
  initAuthBroadcast,
  subscribeAccessToken,
} from "@/lib/auth-store";

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => getAccessToken());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stopBroadcast = initAuthBroadcast();
    const unsub = subscribeAccessToken(setToken);
    void bootstrapSession().finally(() => setReady(true));
    return () => {
      stopBroadcast();
      unsub();
    };
  }, []);

  return {
    accessToken: token,
    isAuthenticated: Boolean(token),
    ready,
  };
}
