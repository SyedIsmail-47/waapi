import { Worker } from "bullmq";
import nodemailer from "nodemailer";
import { QUEUE_EMAIL } from "@waapi/shared";
import { config } from "../config.js";
import { redis } from "./queues.js";

type EmailJobData = {
  to: string;
  kind?: string;
  token?: string;
  subject?: string;
  text?: string;
};

function buildMessage(data: EmailJobData): { subject: string; text: string } {
  if (data.kind === "verify_email" && data.token) {
    return {
      subject: `Verify your ${config.BRAND_NAME} email`,
      text: `Your verification token: ${data.token}\n`,
    };
  }
  if (data.kind === "reset_password" && data.token) {
    return {
      subject: `Reset your ${config.BRAND_NAME} password`,
      text: `Your password reset token: ${data.token}\n`,
    };
  }
  return {
    subject: data.subject ?? `${config.BRAND_NAME} notification`,
    text: data.text ?? "",
  };
}

async function deliver(data: EmailJobData): Promise<void> {
  const from = config.EMAIL_FROM ?? `noreply@${config.brand.slug}.local`;
  const message = buildMessage(data);

  if (config.EMAIL_DRIVER === "console") {
    if (config.NODE_ENV === "production") {
      throw new Error("EMAIL_DRIVER=console is forbidden in production");
    }
    const safe = { ...data } as Record<string, unknown>;
    if (typeof safe.token === "string") safe.token = "[redacted]";
    console.log(JSON.stringify({ service: "email", template: data.kind, ...safe, ...message }));
    return;
  }

  if (config.EMAIL_DRIVER === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [data.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return;
  }

  if (config.EMAIL_DRIVER === "smtp") {
    if (!config.SMTP_URL) throw new Error("SMTP_URL is required");
    const transport = nodemailer.createTransport(config.SMTP_URL);
    await transport.sendMail({
      from,
      to: data.to,
      subject: message.subject,
      text: message.text,
    });
    return;
  }

  throw new Error(`Unsupported EMAIL_DRIVER: ${config.EMAIL_DRIVER}`);
}

export function startEmailWorker(): Worker {
  return new Worker(
    QUEUE_EMAIL,
    async (job) => {
      await deliver(job.data as EmailJobData);
    },
    {
      connection: redis,
      removeOnComplete: { age: 60, count: 100 },
      removeOnFail: { age: 300, count: 100 },
    },
  );
}
