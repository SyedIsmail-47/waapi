import type { Redis } from "ioredis";
import type { Logger } from "../logger.js";
import { FakeControl } from "./fake-client.js";

export const FAKE_CONTROL_CHANNEL = "waapi:fake:control";

export type FakeControlMessage =
  | { op: "scan"; sessionId: string; phoneNumber?: string }
  | { op: "send_timeout"; sessionId: string }
  | { op: "ban"; sessionId: string }
  | { op: "inbound"; sessionId: string; remoteJid: string; text?: string };

export function startFakeControlBus(redis: Redis, log: Logger): Redis {
  const sub = redis.duplicate();
  void sub.subscribe(FAKE_CONTROL_CHANNEL);
  sub.on("message", (_channel, raw) => {
    void (async () => {
      let msg: FakeControlMessage;
      try {
        msg = JSON.parse(raw) as FakeControlMessage;
      } catch {
        log.warn("fake control: invalid json");
        return;
      }
      try {
        switch (msg.op) {
          case "scan":
            await FakeControl.scan(msg.sessionId, msg.phoneNumber);
            break;
          case "send_timeout":
            FakeControl.injectSendTimeout(msg.sessionId);
            break;
          case "ban":
            await FakeControl.injectBan(msg.sessionId);
            break;
          case "inbound":
            await FakeControl.injectInbound(msg.sessionId, {
              remoteJid: msg.remoteJid,
              text: msg.text,
            });
            break;
          default:
            log.warn({ msg }, "fake control: unknown op");
        }
      } catch (err) {
        log.warn({ err, msg }, "fake control: handler failed");
      }
    })();
  });
  return sub;
}

export async function publishFakeControl(
  redis: Redis,
  msg: FakeControlMessage,
): Promise<void> {
  await redis.publish(FAKE_CONTROL_CHANNEL, JSON.stringify(msg));
}
