import { Worker } from "bullmq";
import nodemailer from "nodemailer";
import { QUEUE_EMAIL } from "@waapi/shared";
import { config, getPublicAppUrl } from "../config.js";
import { redis } from "./queues.js";

export type EmailJobData = {
  to: string;
  kind?: string;
  token?: string;
  subject?: string;
  text?: string;
  sessionName?: string;
  reason?: string;
};

export type EmailContent = {
  subject: string;
  text: string;
  html: string;
};

function brandName(): string {
  return process.env.BRAND_NAME?.trim() || config.BRAND_NAME;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absoluteLink(path: string, token: string): string {
  const base = getPublicAppUrl().replace(/\/+$/, "");
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

function wrapHtml(brand: string, title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;background:#f6f6f4;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #ddd;padding:24px">
    <p style="font-size:20px;font-weight:600;margin:0 0 12px">${escapeHtml(brand)}</p>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

/** Build subject + text + HTML for a job (exported for unit tests). */
export function buildEmailContent(data: EmailJobData): EmailContent {
  const brand = brandName();

  if (data.kind === "verify_email" && data.token) {
    const link = absoluteLink("/verify-email", data.token);
    const subject = `Verify your ${brand} email`;
    const text = [
      `Verify your email for ${brand}.`,
      "",
      `Open this link: ${link}`,
      "",
      "If you did not create an account, ignore this message.",
    ].join("\n");
    const html = wrapHtml(
      brand,
      subject,
      `<p>Verify your email for ${escapeHtml(brand)}.</p>
       <p><a href="${escapeHtml(link)}">Verify email</a></p>
       <p style="color:#666;font-size:13px">Or paste: ${escapeHtml(link)}</p>
       <p style="color:#666;font-size:13px">If you did not create an account, ignore this message.</p>`,
    );
    return { subject, text, html };
  }

  if (data.kind === "reset_password" && data.token) {
    const link = absoluteLink("/reset-password", data.token);
    const subject = `Reset your ${brand} password`;
    const text = [
      `Reset your ${brand} password.`,
      "",
      `Open this link: ${link}`,
      "",
      "If you did not request a reset, ignore this message.",
    ].join("\n");
    const html = wrapHtml(
      brand,
      subject,
      `<p>Reset your ${escapeHtml(brand)} password.</p>
       <p><a href="${escapeHtml(link)}">Reset password</a></p>
       <p style="color:#666;font-size:13px">Or paste: ${escapeHtml(link)}</p>
       <p style="color:#666;font-size:13px">If you did not request a reset, ignore this message.</p>`,
    );
    return { subject, text, html };
  }

  if (data.kind === "session_disconnect") {
    const sessionName = data.sessionName ?? "your session";
    const reason = (data.reason ?? "disconnected").replace(/_/g, " ");
    const subject = data.subject ?? `${brand}: session ${reason}`;
    const text =
      data.text ??
      [
        `Your ${brand} session "${sessionName}" is ${reason}.`,
        "",
        "Open the dashboard to reconnect or scan a new QR code.",
        "You can turn off these emails in account settings.",
      ].join("\n");
    const html = wrapHtml(
      brand,
      subject,
      `<p>Your ${escapeHtml(brand)} session <strong>${escapeHtml(sessionName)}</strong> is ${escapeHtml(reason)}.</p>
       <p>Open the dashboard to reconnect or scan a new QR code.</p>
       <p style="color:#666;font-size:13px">You can turn off these emails in account settings.</p>`,
    );
    return { subject, text, html };
  }

  const subject = data.subject ?? `${brand} notification`;
  const text = data.text ?? "";
  return {
    subject,
    text,
    html: wrapHtml(brand, subject, `<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`),
  };
}

/** Deliver one email (exported for unit tests / resend mock). */
export async function deliverEmail(data: EmailJobData): Promise<void> {
  const from = config.EMAIL_FROM ?? `noreply@${config.brand.slug}.local`;
  const message = buildEmailContent(data);

  if (config.EMAIL_DRIVER === "console") {
    if (config.NODE_ENV === "production") {
      throw new Error("EMAIL_DRIVER=console is forbidden in production");
    }
    const safe = { ...data } as Record<string, unknown>;
    if (typeof safe.token === "string") safe.token = "[redacted]";
    console.log(
      JSON.stringify({
        service: "email",
        template: data.kind,
        to: data.to,
        subject: message.subject,
        // Never log full bodies (contain tokens in links) in console driver summary.
        textChars: message.text.length,
        htmlChars: message.html.length,
        ...safe,
      }),
    );
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
        html: message.html,
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
      html: message.html,
    });
    return;
  }

  throw new Error(`Unsupported EMAIL_DRIVER: ${config.EMAIL_DRIVER}`);
}

export function startEmailWorker(): Worker {
  return new Worker(
    QUEUE_EMAIL,
    async (job) => {
      await deliverEmail(job.data as EmailJobData);
    },
    {
      connection: redis,
      removeOnComplete: { age: 60, count: 100 },
      removeOnFail: { age: 300, count: 100 },
    },
  );
}
