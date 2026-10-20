import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { eq, sql } from "drizzle-orm";
import { personalAccessTokens, sessionApiKeys } from "@waapi/db";
import { config } from "../config.js";
import { sha256 } from "../lib/crypto.js";
import { enforceAccountRateLimit } from "./rate-limit.js";
import type { Identity } from "../services/auth.js";

export type AuthType = "jwt" | "pat" | "session_key";
export type RequestIdentity = Identity & {
  authType: AuthType;
  sessionId?: string;
  tokenHash?: string;
  scopes?: string[];
};

const httpError = (message: string, statusCode: number, code: string) =>
  Object.assign(new Error(message), { statusCode, code });

async function touchLastUsed(
  update: () => Promise<unknown>,
  lastUsedAt: Date | string | null,
): Promise<void> {
  if (lastUsedAt) {
    const ts = lastUsedAt instanceof Date ? lastUsedAt.getTime() : new Date(lastUsedAt).getTime();
    if (!Number.isNaN(ts) && Date.now() - ts < 60_000) return;
  }
  await update();
}

function matchesPrefix(token: string, ...prefixes: string[]): string | null {
  for (const p of prefixes) {
    if (token.startsWith(p)) return p;
  }
  return null;
}

export default fp(async (app) => {
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: config.JWT_ACCESS_TTL,
      algorithm: "HS256",
      iss: config.JWT_ISSUER,
      aud: config.JWT_AUDIENCE,
    },
    verify: {
      algorithms: ["HS256"],
      allowedIss: config.JWT_ISSUER,
      allowedAud: config.JWT_AUDIENCE,
    },
  });

  app.decorateRequest("identity", null as unknown as RequestIdentity);

  app.decorate("authenticate", async (request, _reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw httpError("Bearer token required", 401, "UNAUTHORIZED");
    }
    const token = header.slice(7);
    const brand = config.brand;

    const patPrefix = matchesPrefix(token, brand.patPrefix, brand.legacyPatPrefix);
    if (patPrefix) {
      const hash = sha256(token);
      const rows = await app.database.db.execute(sql`
        select
          p.id, p.user_id, p.account_id, p.scopes, p.last_used_at,
          u.disabled_at as user_disabled_at, u.role, u.is_admin,
          a.suspended_at as account_suspended_at
        from personal_access_tokens p
        join users u on u.id = p.user_id
        join accounts a on a.id = p.account_id
        where p.token_hash = ${hash}
          and p.revoked_at is null
        limit 1
      `);
      const row = rows[0] as
        | {
            id: string;
            user_id: string;
            account_id: string;
            scopes: string[] | null;
            last_used_at: Date | null;
            user_disabled_at: Date | null;
            role: string;
            is_admin: boolean;
            account_suspended_at: Date | null;
          }
        | undefined;
      if (!row || row.user_disabled_at || row.account_suspended_at) {
        throw httpError(row ? "Forbidden" : "Invalid token", row ? 403 : 401, row ? "FORBIDDEN" : "UNAUTHORIZED");
      }
      await touchLastUsed(
        () =>
          app.database.db
            .update(personalAccessTokens)
            .set({ lastUsedAt: new Date() })
            .where(eq(personalAccessTokens.id, row.id)),
        row.last_used_at,
      );
      request.identity = {
        userId: row.user_id,
        accountId: row.account_id,
        role: row.role as Identity["role"],
        isAdmin: row.is_admin,
        authType: "pat",
        tokenHash: hash,
        scopes: row.scopes ?? ["account"],
      };
      await enforceAccountRateLimit(row.account_id);
      return;
    }

    const skPrefix = matchesPrefix(token, brand.sessionKeyPrefix, brand.legacySessionKeyPrefix);
    if (skPrefix) {
      const hash = sha256(token);
      const rows = await app.database.db.execute(sql`
        select
          k.id, k.account_id, k.session_id, k.last_used_at,
          a.suspended_at as account_suspended_at
        from session_api_keys k
        join accounts a on a.id = k.account_id
        where k.token_hash = ${hash}
          and k.revoked_at is null
        limit 1
      `);
      const row = rows[0] as
        | {
            id: string;
            account_id: string;
            session_id: string;
            last_used_at: Date | null;
            account_suspended_at: Date | null;
          }
        | undefined;
      if (!row || row.account_suspended_at) {
        throw httpError(row ? "Forbidden" : "Invalid token", row ? 403 : 401, row ? "FORBIDDEN" : "UNAUTHORIZED");
      }
      await touchLastUsed(
        () =>
          app.database.db
            .update(sessionApiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(sessionApiKeys.id, row.id)),
        row.last_used_at,
      );
      request.identity = {
        userId: row.id,
        accountId: row.account_id,
        role: "member",
        isAdmin: false,
        authType: "session_key",
        sessionId: row.session_id,
        tokenHash: hash,
      };
      await enforceAccountRateLimit(row.account_id);
      return;
    }

    await request.jwtVerify();
    const payload = request.user as {
      userId: string;
      accountId: string;
      role: Identity["role"];
      isAdmin: boolean;
    };
    const rows = await app.database.db.execute(sql`
      select
        u.id as user_id, u.account_id, u.role, u.is_admin, u.disabled_at,
        a.suspended_at
      from users u
      join accounts a on a.id = u.account_id
      where u.id = ${payload.userId}::uuid
      limit 1
    `);
    const row = rows[0] as
      | {
          user_id: string;
          account_id: string;
          role: Identity["role"];
          is_admin: boolean;
          disabled_at: Date | null;
          suspended_at: Date | null;
        }
      | undefined;
    if (!row || row.disabled_at || row.suspended_at) {
      throw httpError("Forbidden", 403, "FORBIDDEN");
    }
    request.identity = {
      userId: row.user_id,
      accountId: row.account_id,
      role: row.role,
      isAdmin: row.is_admin,
      authType: "jwt",
      tokenHash: sha256(token),
    };
    await enforceAccountRateLimit(row.account_id);
  });

  app.decorate("requireAuthType", (...types: AuthType[]) => {
    return async (
      request: import("fastify").FastifyRequest,
      _reply: import("fastify").FastifyReply,
    ) => {
      await app.authenticate(request, _reply);
      if (!types.includes(request.identity.authType)) {
        throw httpError("Forbidden for this credential type", 403, "FORBIDDEN");
      }
      if (request.identity.authType === "pat") {
        const scopes = request.identity.scopes ?? [];
        if (!scopes.includes("account") && !scopes.includes("*")) {
          throw httpError("PAT missing account scope", 403, "FORBIDDEN");
        }
      }
    };
  });
});
