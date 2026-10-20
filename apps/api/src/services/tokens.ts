import { and, eq, isNull } from "drizzle-orm";
import { personalAccessTokens, sessionApiKeys, sessions, type Db } from "@waapi/db";
import { config } from "../config.js";
import { randomToken, sha256 } from "../lib/crypto.js";

export async function createPat(database: Db, userId: string, accountId: string, name: string) {
  const prefix = config.brand.patPrefix;
  const token = randomToken(prefix);
  const [row] = await database.db
    .insert(personalAccessTokens)
    .values({
      userId,
      accountId,
      name,
      tokenPrefix: token.slice(0, Math.min(18, prefix.length + 8)),
      tokenHash: sha256(token),
      scopes: ["account"],
    })
    .returning();
  return {
    id: row!.id,
    name: row!.name,
    tokenPrefix: row!.tokenPrefix,
    scopes: row!.scopes,
    createdAt: row!.createdAt,
    token,
  };
}

export async function listPats(database: Db, accountId: string) {
  return database.db
    .select({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      tokenPrefix: personalAccessTokens.tokenPrefix,
      scopes: personalAccessTokens.scopes,
      lastUsedAt: personalAccessTokens.lastUsedAt,
      createdAt: personalAccessTokens.createdAt,
      revokedAt: personalAccessTokens.revokedAt,
    })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.accountId, accountId));
}

export async function revokePat(database: Db, accountId: string, id: string) {
  const [row] = await database.db
    .update(personalAccessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(personalAccessTokens.id, id),
        eq(personalAccessTokens.accountId, accountId),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .returning();
  if (!row) {
    throw Object.assign(new Error("Token not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
}

export async function createSessionKey(
  database: Db,
  accountId: string,
  sessionId: string,
  name: string,
) {
  const [session] = await database.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!session) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const prefix = config.brand.sessionKeyPrefix;
  const token = randomToken(prefix);
  const [row] = await database.db
    .insert(sessionApiKeys)
    .values({
      accountId,
      sessionId,
      name,
      tokenPrefix: token.slice(0, Math.min(17, prefix.length + 8)),
      tokenHash: sha256(token),
    })
    .returning();
  return {
    id: row!.id,
    name: row!.name,
    sessionId: row!.sessionId,
    tokenPrefix: row!.tokenPrefix,
    createdAt: row!.createdAt,
    token,
  };
}

export async function revokeSessionKey(
  database: Db,
  accountId: string,
  sessionId: string,
  id: string,
) {
  const [row] = await database.db
    .update(sessionApiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessionApiKeys.id, id),
        eq(sessionApiKeys.accountId, accountId),
        eq(sessionApiKeys.sessionId, sessionId),
        isNull(sessionApiKeys.revokedAt),
      ),
    )
    .returning();
  if (!row) {
    throw Object.assign(new Error("Session key not found"), {
      statusCode: 404,
      code: "NOT_FOUND",
    });
  }
}
