import type { FastifyRequest } from "fastify";

function trustCloudflare(): boolean {
  const raw = process.env.TRUST_CLOUDFLARE;
  if (raw == null) return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Single client-IP helper for lockout, rate limits, and audit.
 *
 * - When TRUST_CLOUDFLARE=true: prefer CF-Connecting-IP (only safe behind CF +
 *   nginx real_ip that overwrites the header; VPS firewall must allow 80/443
 *   from Cloudflare only — see deploy/nginx.conf).
 * - Otherwise: use request.ip from Fastify with trustProxy = TRUST_PROXY_HOPS
 *   (numeric hop count, default 1). Do not read X-Forwarded-For here.
 */
export function clientIp(request: FastifyRequest): string {
  if (trustCloudflare()) {
    const cf = request.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) {
      return cf.split(",")[0]!.trim();
    }
  }
  return request.ip;
}
