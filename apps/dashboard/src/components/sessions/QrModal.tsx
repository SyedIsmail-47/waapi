import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { BanRiskNotice } from "@/components/sessions/BanRiskNotice";
import { StatusBadge } from "@/components/sessions/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessionStatus } from "@/hooks/use-session-status";
import { api } from "@/lib/api-client";
import { friendlySessionError } from "@/lib/friendly-errors";

export function QrModal({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
}) {
  const status = useSessionStatus(sessionId, open);

  const expired = useMemo(() => {
    const qr = status.data?.qr;
    if (status.data?.qrExpired) return true;
    if (!qr?.expiresAt) return false;
    return new Date(qr.expiresAt) <= new Date();
  }, [status.data]);

  const qrValue = useMemo(() => {
    const qr = status.data?.qr;
    if (!qr?.value || expired) return null;
    return qr.value;
  }, [status.data, expired]);

  const connected = status.data?.status === "connected";
  const errorCopy = friendlySessionError(status.data?.lastError);

  const refreshQr = async () => {
    await api(`/api/v1/sessions/${sessionId}/connect`, { method: "POST" });
    await status.refetch();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect WhatsApp</DialogTitle>
          <DialogDescription>
            Scan with WhatsApp → Linked devices. Status polls every few seconds.
          </DialogDescription>
        </DialogHeader>
        <BanRiskNotice />
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={status.data?.status ?? "need_scan"} />
          {status.data?.phoneNumber ? (
            <span className="text-sm text-muted">{status.data.phoneNumber}</span>
          ) : null}
        </div>
        <div className="flex min-h-[260px] items-center justify-center bg-accent-soft p-4">
          {connected ? (
            <p className="font-display text-2xl text-accent">Connected</p>
          ) : qrValue ? (
            <div className="bg-white p-3">
              <QRCodeSVG value={qrValue} size={220} level="M" includeMargin />
            </div>
          ) : (
            <p className="max-w-xs text-center text-sm text-muted">
              {expired
                ? friendlySessionError("QR_EXPIRED")
                : "Waiting for QR… use Refresh QR if it stays empty."}
            </p>
          )}
        </div>
        {errorCopy ? (
          <p className="text-sm text-warn" role="alert">
            {errorCopy}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => void refreshQr()}>
            Refresh QR
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
