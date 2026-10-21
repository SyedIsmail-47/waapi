import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type SessionStatus = {
  id: string;
  status: string;
  phoneNumber: string | null;
  lastError: string | null;
  qr: { value: string; updatedAt: string; expiresAt: string } | null;
  qrExpired?: boolean;
};

export function useSessionStatus(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["session-status", sessionId],
    enabled: Boolean(sessionId) && enabled,
    refetchInterval: 2500,
    queryFn: () => api<SessionStatus>(`/api/v1/sessions/${sessionId}/status`),
  });
}
