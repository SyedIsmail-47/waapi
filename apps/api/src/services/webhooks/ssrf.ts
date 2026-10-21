import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";
import ipaddr from "ipaddr.js";

function allowHttpWebhooks(): boolean {
  const raw = process.env.ALLOW_HTTP_WEBHOOKS;
  return raw != null && ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export type LookupFn = (
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/** Expand decimal / dotted-hex / octal-ish IPv4 literals into dotted decimal when possible. */
function coerceIpLiteral(hostname: string): string | null {
  const host = normalizeHostname(hostname);
  if (isIP(host)) return host;

  // Pure decimal IPv4 (e.g. 2130706433)
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
    }
  }

  // Dotted hex/octal forms like 0x7f.1 or 0177.0.0.1 — reject by attempting ipaddr parse after
  // converting each octet if hex/octal prefixed.
  if (host.includes(".")) {
    const parts = host.split(".");
    if (parts.length === 4 || parts.length === 2) {
      try {
        const nums = parts.map((part) => {
          if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part, 16);
          if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
          if (/^\d+$/.test(part)) return Number(part);
          throw new Error("bad");
        });
        if (nums.length === 2) {
          // 0x7f.1 → 127.0.0.1 style (a.b as 127.1)
          const a = nums[0]!;
          const b = nums[1]!;
          if (a <= 255 && b <= 0xffffff) {
            return [a, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join(".");
          }
        }
        if (nums.every((n) => n >= 0 && n <= 255)) return nums.join(".");
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return true;
  }

  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isBlockedAddress(v6.toIPv4Address().toString());
    }
    const range = v6.range();
    if (
      range === "unspecified" ||
      range === "loopback" ||
      range === "uniqueLocal" ||
      range === "linkLocal" ||
      range === "multicast" ||
      range === "reserved"
    ) {
      return true;
    }
    // fc00::/7 unique local already covered; ff00::/8 multicast covered
    return false;
  }

  const v4 = parsed as ipaddr.IPv4;
  const range = v4.range();
  if (
    range === "unspecified" ||
    range === "broadcast" ||
    range === "multicast" ||
    range === "linkLocal" ||
    range === "loopback" ||
    range === "private" ||
    range === "reserved" ||
    range === "carrierGradeNat" ||
    range === "benchmarking"
  ) {
    return true;
  }
  // 192.0.0.0/24 (IETF protocol assignments) — ipaddr may classify as reserved; double-check
  const octets = v4.octets;
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) return true;
  if (octets[0]! >= 240) return true;
  return false;
}

export async function resolveAndValidate(
  hostname: string,
  lookupImpl: typeof dnsLookup = dnsLookup,
): Promise<{ address: string; family: number }> {
  const host = normalizeHostname(hostname);
  const literal = coerceIpLiteral(host);
  if (literal) {
    if (isBlockedAddress(literal)) {
      throw Object.assign(new Error("Webhook URL resolves to a private address"), {
        statusCode: 400,
        code: "SSRF_BLOCKED",
      });
    }
    return { address: literal, family: isIP(literal) === 6 ? 6 : 4 };
  }

  const results = await lookupImpl(host, { all: true, verbatim: true });
  const list = Array.isArray(results) ? results : [results];
  if (!list.length) {
    throw Object.assign(new Error("Webhook URL DNS lookup failed"), {
      statusCode: 400,
      code: "SSRF_BLOCKED",
    });
  }
  for (const entry of list) {
    if (isBlockedAddress(entry.address)) {
      throw Object.assign(new Error("Webhook URL resolves to a private address"), {
        statusCode: 400,
        code: "SSRF_BLOCKED",
      });
    }
  }
  const first = list[0]!;
  return { address: first.address, family: first.family };
}

export function assertWebhookUrlShape(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Invalid webhook URL"), {
      statusCode: 400,
      code: "SSRF_BLOCKED",
    });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("Webhook URL must not include userinfo"), {
      statusCode: 400,
      code: "SSRF_BLOCKED",
    });
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && allowHttpWebhooks()) return url;
  throw Object.assign(new Error("Webhook URL must use HTTPS"), {
    statusCode: 400,
    code: "SSRF_BLOCKED",
  });
}

/** Legacy name used by upsert path — shape + resolve check only (connect pins IP). */
export async function assertPublicUrl(value: string): Promise<URL> {
  const url = assertWebhookUrlShape(value);
  await resolveAndValidate(url.hostname);
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

function wantsAll(opts: unknown): boolean {
  return typeof opts === "object" && opts != null && "all" in opts && Boolean((opts as { all?: boolean }).all);
}

/** Exported for tests — undici may call with `{ all: true }` expecting an address array. */
export function createPinnedLookup(options?: { lookup?: LookupFn }) {
  return (hostname: string, opts: unknown, cb: LookupCallback) => {
    const run = async () => {
      let address: string;
      let family: number;
      if (options?.lookup) {
        await new Promise<void>((resolve, reject) => {
          options.lookup!(hostname, opts, (err, addr, fam) => {
            if (err) reject(err);
            else {
              address = addr;
              family = fam;
              resolve();
            }
          });
        });
      } else {
        const validated = await resolveAndValidate(hostname);
        address = validated.address;
        family = validated.family;
      }
      if (wantsAll(opts)) {
        cb(null, [{ address: address!, family: family! }]);
      } else {
        cb(null, address!, family!);
      }
    };
    void run().catch((err: NodeJS.ErrnoException) => cb(err, "", 4));
  };
}

export function createPinnedAgent(options?: {
  lookup?: LookupFn;
  connectTimeout?: number;
}): Agent {
  return new Agent({
    connect: {
      timeout: options?.connectTimeout ?? 10_000,
      lookup: createPinnedLookup({ lookup: options?.lookup }),
    },
  });
}

export const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

/**
 * Drain response body up to maxBytes. Oversize: stop reading / destroy stream.
 * Callers judge success by HTTP status code (do not throw on size).
 */
export async function dumpBodyLimited(
  body: Dispatcher.ResponseData["body"],
  maxBytes = MAX_WEBHOOK_RESPONSE_BYTES,
): Promise<{ truncated: boolean; bytes: number }> {
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) {
        body.destroy();
        return { truncated: true, bytes: total };
      }
    }
  } catch {
    /* destroyed stream / aborted — ignore */
  }
  return { truncated: false, bytes: total };
}
