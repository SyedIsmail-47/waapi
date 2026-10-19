import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../crypto/aes.js";
import type { Db } from "../db/client.js";
import { sessions, waAuthCreds, waAuthKeys } from "../db/schema.js";

type KeyType = keyof SignalDataTypeMap;

export type AuthStateOptions = {
  db: Db["db"];
  sessionId: string;
  accountId: string;
  encryptionKey: Buffer;
  keyVersion: number;
};

async function assertSessionOwned(
  db: Db["db"],
  accountId: string,
  sessionId: string,
): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!rows[0]) {
    throw new Error("SESSION_NOT_FOUND_FOR_ACCOUNT");
  }
}

export async function usePostgresAuthState(
  opts: AuthStateOptions,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const { db, sessionId, accountId, encryptionKey, keyVersion } = opts;
  await assertSessionOwned(db, accountId, sessionId);

  let creds: AuthenticationCreds;
  const existing = await db
    .select()
    .from(waAuthCreds)
    .where(eq(waAuthCreds.sessionId, sessionId))
    .limit(1);

  if (existing[0]) {
    const raw = decryptJson<unknown>(
      {
        ciphertext: existing[0].ciphertext,
        iv: existing[0].iv,
        authTag: existing[0].authTag,
      },
      encryptionKey,
    );
    creds = JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as AuthenticationCreds;
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async (): Promise<void> => {
    await assertSessionOwned(db, accountId, sessionId);
    const blob = encryptJson(
      JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
      encryptionKey,
    );
    await db
      .insert(waAuthCreds)
      .values({
        sessionId,
        ciphertext: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
        keyVersion,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: waAuthCreds.sessionId,
        set: {
          ciphertext: blob.ciphertext,
          iv: blob.iv,
          authTag: blob.authTag,
          keyVersion,
          updatedAt: new Date(),
        },
      });
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        await assertSessionOwned(db, accountId, sessionId);
        const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const id of ids) {
          const rows = await db
            .select()
            .from(waAuthKeys)
            .where(
              and(
                eq(waAuthKeys.sessionId, sessionId),
                eq(waAuthKeys.keyType, type),
                eq(waAuthKeys.keyId, id),
              ),
            )
            .limit(1);
          const row = rows[0];
          if (!row) continue;
          const value = decryptJson<unknown>(
            {
              ciphertext: row.ciphertext,
              iv: row.iv,
              authTag: row.authTag,
            },
            encryptionKey,
          );
          data[id] = value as SignalDataTypeMap[typeof type];
        }
        return data;
      },
      set: async (data) => {
        await assertSessionOwned(db, accountId, sessionId);
        for (const category of Object.keys(data) as KeyType[]) {
          const entries = data[category];
          if (!entries) continue;
          for (const id of Object.keys(entries)) {
            const value = entries[id];
            await db
              .delete(waAuthKeys)
              .where(
                and(
                  eq(waAuthKeys.sessionId, sessionId),
                  eq(waAuthKeys.keyType, category),
                  eq(waAuthKeys.keyId, id),
                ),
              );
            if (value) {
              const blob = encryptJson(
                JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
                encryptionKey,
              );
              await db.insert(waAuthKeys).values({
                sessionId,
                keyType: category,
                keyId: id,
                ciphertext: blob.ciphertext,
                iv: blob.iv,
                authTag: blob.authTag,
                keyVersion,
                updatedAt: new Date(),
              });
            }
          }
        }
      },
    },
  };

  return { state, saveCreds };
}

export async function hasStoredCreds(db: Db["db"], sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ sessionId: waAuthCreds.sessionId })
    .from(waAuthCreds)
    .where(eq(waAuthCreds.sessionId, sessionId))
    .limit(1);
  return Boolean(rows[0]);
}
