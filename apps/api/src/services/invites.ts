import { and, eq, gt, isNull } from "drizzle-orm";
import { inviteCodes, securityAuditLog, type Db } from "@waapi/db";
import { randomToken, sha256 } from "../lib/crypto.js";

type Tx = {
  update: Db["db"]["update"];
  insert: Db["db"]["insert"];
};

const db = (value: Db) => value.db;

export async function createInviteCode(
  database: Db,
  opts: { expiresInHours?: number; note?: string } = {},
): Promise<{ id: string; code: string; expiresAt: Date; codePrefix: string }> {
  const hours = opts.expiresInHours ?? 168;
  const code = randomToken("inv_");
  const expiresAt = new Date(Date.now() + hours * 3_600_000);
  const [row] = await db(database)
    .insert(inviteCodes)
    .values({
      codeHash: sha256(code),
      codePrefix: code.slice(0, 12),
      expiresAt,
      note: opts.note,
    })
    .returning();
  await db(database).insert(securityAuditLog).values({
    eventType: "invite.created",
    meta: { inviteId: row!.id, codePrefix: row!.codePrefix, expiresAt: expiresAt.toISOString() },
  });
  return { id: row!.id, code, expiresAt, codePrefix: row!.codePrefix };
}

/**
 * Atomically consume a single-use invite. Call inside the register transaction
 * after the user row exists so used_by_user_id can be set.
 */
export async function consumeInviteCode(
  tx: Tx,
  code: string,
  userId: string,
): Promise<void> {
  const hash = sha256(code.trim());
  const updated = await tx
    .update(inviteCodes)
    .set({ usedAt: new Date(), usedByUserId: userId })
    .where(
      and(
        eq(inviteCodes.codeHash, hash),
        isNull(inviteCodes.usedAt),
        gt(inviteCodes.expiresAt, new Date()),
      ),
    )
    .returning({ id: inviteCodes.id });
  if (!updated.length) {
    throw Object.assign(new Error("Invite code is invalid or already used"), {
      statusCode: 400,
      code: "INVITE_INVALID",
    });
  }
}
