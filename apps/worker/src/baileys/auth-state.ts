import {
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { pino } from "pino";
import { authAad, decryptJson, encryptJson } from "../crypto/aes.js";
import type { EncryptionKeyRing } from "../crypto/key-ring.js";
import type { Db } from "../db/client.js";
import { sessions, waAuthCreds, waAuthKeys } from "../db/schema.js";

type KeyType = keyof SignalDataTypeMap;

const CREDS_TYPE = "creds";
const CREDS_ID = "default";

export type AuthStateOptions = {
  db: Db["db"];
  sessionId: string;
  accountId: string;
  keyRing: EncryptionKeyRing;
};

export type PostgresAuthState = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Await all queued saveCreds / key writes. Call before releasing lease / closing DB. */
  flush: () => Promise<void>;
  /** Block further writes. Must be called before wipe/disconnect. */
  close: () => void;
  readonly closed: boolean;
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

export async function usePostgresAuthState(opts: AuthStateOptions): Promise<PostgresAuthState> {
  const { db, sessionId, accountId, keyRing } = opts;
  // Ownership checked once at construction — not per get/set/saveCreds call.
  await assertSessionOwned(db, accountId, sessionId);

  let closed = false;
  let writeChain: Promise<void> = Promise.resolve();

  const enqueueWrite = (fn: () => Promise<void>): Promise<void> => {
    writeChain = writeChain.then(fn, fn);
    return writeChain;
  };

  const credsAad = authAad(sessionId, CREDS_TYPE, CREDS_ID);
  let creds: AuthenticationCreds;
  const existing = await db
    .select()
    .from(waAuthCreds)
    .where(eq(waAuthCreds.sessionId, sessionId))
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    const raw = decryptJson<unknown>(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      },
      keyRing.get(row.keyVersion),
      credsAad,
    );
    creds = JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as AuthenticationCreds;
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = (): Promise<void> =>
    enqueueWrite(async () => {
      if (closed) return;
      const { version, key } = keyRing.current;
      const blob = encryptJson(
        JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
        key,
        credsAad,
      );
      await db
        .insert(waAuthCreds)
        .values({
          sessionId,
          ciphertext: blob.ciphertext,
          iv: blob.iv,
          authTag: blob.authTag,
          keyVersion: version,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: waAuthCreds.sessionId,
          set: {
            ciphertext: blob.ciphertext,
            iv: blob.iv,
            authTag: blob.authTag,
            keyVersion: version,
            updatedAt: new Date(),
          },
        });
    });

  const rawKeys = {
    get: async <T extends KeyType>(type: T, ids: string[]) => {
      if (closed || ids.length === 0) {
        return {} as { [id: string]: SignalDataTypeMap[T] };
      }
      const data: { [id: string]: SignalDataTypeMap[T] } = {};
      const rows = await db
        .select()
        .from(waAuthKeys)
        .where(
          and(
            eq(waAuthKeys.sessionId, sessionId),
            eq(waAuthKeys.keyType, type),
            inArray(waAuthKeys.keyId, ids),
          ),
        );
      for (const row of rows) {
        const value = decryptJson<unknown>(
          {
            ciphertext: row.ciphertext,
            iv: row.iv,
            authTag: row.authTag,
          },
          keyRing.get(row.keyVersion),
          authAad(sessionId, type, row.keyId),
        );
        data[row.keyId] = value as SignalDataTypeMap[T];
      }
      return data;
    },
    set: async (data: { [T in KeyType]?: { [id: string]: SignalDataTypeMap[T] | null } }) => {
      if (closed) return;
      await db.transaction(async (tx) => {
        const { version, key } = keyRing.current;
        const upserts: Array<{
          sessionId: string;
          keyType: string;
          keyId: string;
          ciphertext: Buffer;
          iv: Buffer;
          authTag: Buffer;
          keyVersion: number;
          updatedAt: Date;
        }> = [];
        const deleteConds: ReturnType<typeof and>[] = [];

        for (const category of Object.keys(data) as KeyType[]) {
          const entries = data[category];
          if (!entries) continue;
          for (const id of Object.keys(entries)) {
            const value = entries[id];
            if (value == null) {
              deleteConds.push(
                and(
                  eq(waAuthKeys.sessionId, sessionId),
                  eq(waAuthKeys.keyType, category),
                  eq(waAuthKeys.keyId, id),
                )!,
              );
              continue;
            }
            const blob = encryptJson(
              JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
              key,
              authAad(sessionId, category, id),
            );
            upserts.push({
              sessionId,
              keyType: category,
              keyId: id,
              ciphertext: blob.ciphertext,
              iv: blob.iv,
              authTag: blob.authTag,
              keyVersion: version,
              updatedAt: new Date(),
            });
          }
        }

        if (deleteConds.length > 0) {
          await tx.delete(waAuthKeys).where(or(...deleteConds));
        }
        if (upserts.length > 0) {
          await tx
            .insert(waAuthKeys)
            .values(upserts)
            .onConflictDoUpdate({
              target: [waAuthKeys.sessionId, waAuthKeys.keyType, waAuthKeys.keyId],
              set: {
                ciphertext: sql`excluded.ciphertext`,
                iv: sql`excluded.iv`,
                authTag: sql`excluded.auth_tag`,
                keyVersion: sql`excluded.key_version`,
                updatedAt: sql`excluded.updated_at`,
              },
            });
        }
      });
    },
  };

  const keys = makeCacheableSignalKeyStore(rawKeys, pino({ level: "silent" }));

  const state: AuthenticationState = {
    creds,
    keys,
  };

  return {
    state,
    saveCreds,
    async flush() {
      await writeChain;
    },
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

export async function hasStoredCreds(db: Db["db"], sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ sessionId: waAuthCreds.sessionId })
    .from(waAuthCreds)
    .where(eq(waAuthCreds.sessionId, sessionId))
    .limit(1);
  return Boolean(rows[0]);
}
