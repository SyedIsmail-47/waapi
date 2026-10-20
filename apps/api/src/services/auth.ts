import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { and, count, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  accounts,
  emailVerificationTokens,
  loginAttempts,
  passwordResetTokens,
  refreshTokens,
  securityAuditLog,
  users,
  type Db,
} from "@waapi/db";
import { config } from "../config.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { defaultJobOptions, emailQueue } from "./queues.js";

const db = (value: Db) => value.db;

/** Precomputed argon2id hash so unknown-email logins still pay verify cost. */
let dummyHashPromise: Promise<string> | null = null;
const dummyHash = () => {
  dummyHashPromise ??= argon2.hash("timing-dummy-password-not-a-secret", {
    type: argon2.argon2id,
  });
  return dummyHashPromise;
};

const expiry = (ttl: string): Date => {
  const match = /^(\d+)([mhd])$/.exec(ttl);
  if (!match) throw new Error(`Invalid TTL: ${ttl}`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!]!;
  return new Date(Date.now() + Number(match[1]) * unit);
};

export type Identity = {
  userId: string;
  accountId: string;
  role: string;
  isAdmin: boolean;
};

async function audit(
  database: Db,
  identity: Partial<Identity>,
  eventType: string,
  ip?: string,
  meta?: Record<string, unknown>,
) {
  await db(database).insert(securityAuditLog).values({
    accountId: identity.accountId,
    userId: identity.userId,
    eventType,
    ip,
    meta: meta ?? {},
  });
}

async function issueRefresh(database: Db, userId: string, familyId = randomUUID()) {
  const token = randomToken();
  const [row] = await db(database)
    .insert(refreshTokens)
    .values({
      userId,
      familyId,
      tokenHash: sha256(token),
      expiresAt: expiry(config.REFRESH_TTL),
    })
    .returning();
  return { token, row: row! };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

export async function register(
  database: Db,
  input: { email: string; password: string; name?: string },
  ip?: string,
) {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  let result: { account: typeof accounts.$inferSelect; user: typeof users.$inferSelect; verificationToken: string };
  try {
    result = await db(database).transaction(async (tx) => {
      const [account] = await tx
        .insert(accounts)
        .values({ name: input.name ?? email })
        .returning();
      const [user] = await tx
        .insert(users)
        .values({ accountId: account!.id, email, passwordHash, role: "owner" })
        .returning();
      const token = randomToken();
      await tx.insert(emailVerificationTokens).values({
        userId: user!.id,
        tokenHash: sha256(token),
        expiresAt: expiry("24h"),
      });
      return { account: account!, user: user!, verificationToken: token };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Object.assign(new Error("Email already registered"), {
        statusCode: 409,
        code: "CONFLICT",
      });
    }
    throw err;
  }
  await emailQueue.add(
    "verify-email",
    {
      to: email,
      subject: "Verify your email",
      kind: "verify_email",
      // token only in job payload briefly; removeOnComplete clears it
      token: result.verificationToken,
    },
    defaultJobOptions,
  );
  await audit(database, { accountId: result.account.id, userId: result.user.id }, "auth.register", ip);
  return result;
}

export async function login(database: Db, emailInput: string, password: string, ip: string) {
  const email = emailInput.trim().toLowerCase();
  const since = new Date(Date.now() - 15 * 60_000);
  const [byEmail] = await db(database)
    .select({ value: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.email, email),
        eq(loginAttempts.succeeded, false),
        gt(loginAttempts.createdAt, since),
      ),
    );
  const [byIp] = await db(database)
    .select({ value: count() })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.ip, ip),
        eq(loginAttempts.succeeded, false),
        gt(loginAttempts.createdAt, since),
      ),
    );
  if ((byEmail?.value ?? 0) >= 10 || (byIp?.value ?? 0) >= 30) {
    throw Object.assign(new Error("Too many login attempts"), {
      statusCode: 429,
      code: "BRUTE_FORCE_LOCKED",
    });
  }

  const [user] = await db(database).select().from(users).where(eq(users.email, email)).limit(1);
  const hash = user?.passwordHash ?? (await dummyHash());
  const valid = await argon2.verify(hash, password).catch(() => false);
  const ok = Boolean(user && valid);
  await db(database).insert(loginAttempts).values({ email, ip, succeeded: ok });
  if (!ok) {
    throw Object.assign(new Error("Invalid credentials"), {
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
    });
  }
  if (user!.disabledAt) {
    throw Object.assign(new Error("Account disabled"), { statusCode: 403, code: "FORBIDDEN" });
  }
  if (!user!.emailVerifiedAt) {
    throw Object.assign(new Error("Email is not verified"), {
      statusCode: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
  }
  const [account] = await db(database)
    .select()
    .from(accounts)
    .where(eq(accounts.id, user!.accountId))
    .limit(1);
  if (account?.suspendedAt) {
    throw Object.assign(new Error("Account suspended"), { statusCode: 403, code: "FORBIDDEN" });
  }
  const refresh = await issueRefresh(database, user!.id);
  await audit(database, { accountId: user!.accountId, userId: user!.id }, "auth.login", ip);
  return {
    identity: {
      userId: user!.id,
      accountId: user!.accountId,
      role: user!.role,
      isAdmin: user!.isAdmin,
    },
    refreshToken: refresh.token,
  };
}

function isDeadlock(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /deadlock detected/i.test(msg);
}

export async function rotateRefresh(database: Db, token: string, ip?: string) {
  const hash = sha256(token);
  const revokedError = () =>
    Object.assign(new Error("Refresh token revoked"), {
      statusCode: 401,
      code: "TOKEN_REVOKED",
    });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Never perform family revoke inside a TX that may roll back on throw.
      const outcome = await db(database).transaction(async (tx) => {
        const claimed = await tx.execute(sql`
          update refresh_tokens
          set revoked_at = now()
          where token_hash = ${hash}
            and revoked_at is null
            and expires_at > now()
          returning id, user_id, family_id
        `);
        const current = claimed[0] as
          | { id: string; user_id: string; family_id: string }
          | undefined;

        if (!current) {
          const [existing] = await tx
            .select()
            .from(refreshTokens)
            .where(eq(refreshTokens.tokenHash, hash))
            .limit(1);
          if (existing) {
            return {
              kind: "reuse" as const,
              familyId: existing.familyId,
              userId: existing.userId,
            };
          }
          return { kind: "revoked" as const };
        }

        const [user] = await tx.select().from(users).where(eq(users.id, current.user_id)).limit(1);
        if (!user || user.disabledAt) {
          return { kind: "unauthorized" as const };
        }
        const nextToken = randomToken();
        const [next] = await tx
          .insert(refreshTokens)
          .values({
            userId: user.id,
            familyId: current.family_id,
            tokenHash: sha256(nextToken),
            expiresAt: expiry(config.REFRESH_TTL),
          })
          .returning();
        await tx
          .update(refreshTokens)
          .set({ replacedBy: next!.id })
          .where(eq(refreshTokens.id, current.id));
        return {
          kind: "ok" as const,
          identity: {
            userId: user.id,
            accountId: user.accountId,
            role: user.role,
            isAdmin: user.isAdmin,
          },
          refreshToken: nextToken,
        };
      });

      if (outcome.kind === "reuse") {
        await db(database)
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(refreshTokens.familyId, outcome.familyId));
        await db(database).insert(securityAuditLog).values({
          userId: outcome.userId,
          eventType: "auth.refresh_reuse",
          ip,
          meta: { familyId: outcome.familyId },
        });
        throw revokedError();
      }
      if (outcome.kind === "revoked") throw revokedError();
      if (outcome.kind === "unauthorized") {
        throw Object.assign(new Error("User not found"), { statusCode: 401, code: "UNAUTHORIZED" });
      }
      return { identity: outcome.identity, refreshToken: outcome.refreshToken };
    } catch (err) {
      if (isDeadlock(err) && attempt < 2) continue;
      if (isDeadlock(err)) throw revokedError();
      throw err;
    }
  }
  throw revokedError();
}

export async function logoutAll(database: Db, userId: string) {
  await db(database)
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function verifyEmail(database: Db, token: string) {
  const hash = sha256(token);
  await db(database).transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      update email_verification_tokens
      set used_at = now()
      where token_hash = ${hash}
        and used_at is null
        and expires_at > now()
      returning id, user_id
    `);
    const row = claimed[0] as { id: string; user_id: string } | undefined;
    if (!row) {
      throw Object.assign(new Error("Invalid verification token"), {
        statusCode: 400,
        code: "TOKEN_REVOKED",
      });
    }
    await tx
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, row.user_id));
  });
}

export async function resendVerification(database: Db, emailInput: string) {
  const email = emailInput.trim().toLowerCase();
  const [user] = await db(database).select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || user.emailVerifiedAt) return;
  await db(database)
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.userId, user.id),
        isNull(emailVerificationTokens.usedAt),
      ),
    );
  const token = randomToken();
  await db(database).insert(emailVerificationTokens).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: expiry("24h"),
  });
  await emailQueue.add(
    "verify-email",
    { to: email, kind: "verify_email", token },
    defaultJobOptions,
  );
}

export async function forgotPassword(database: Db, emailInput: string) {
  const email = emailInput.trim().toLowerCase();
  const [user] = await db(database).select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) return;

  const since = new Date(Date.now() - 15 * 60_000);
  const [recent] = await db(database)
    .select({ value: count() })
    .from(passwordResetTokens)
    .where(
      and(eq(passwordResetTokens.userId, user.id), gt(passwordResetTokens.createdAt, since)),
    );
  if ((recent?.value ?? 0) >= 3) return;

  await db(database)
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)),
    );

  const token = randomToken();
  await db(database).insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: expiry("1h"),
  });
  await emailQueue.add(
    "reset-password",
    { to: user.email, kind: "reset_password", token },
    defaultJobOptions,
  );
}

export async function resetPassword(database: Db, token: string, password: string) {
  await db(database).transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      update password_reset_tokens
      set used_at = now()
      where token_hash = ${sha256(token)}
        and used_at is null
        and expires_at > now()
      returning id, user_id
    `);
    const row = claimed[0] as { id: string; user_id: string } | undefined;
    if (!row) {
      throw Object.assign(new Error("Invalid reset token"), {
        statusCode: 400,
        code: "TOKEN_REVOKED",
      });
    }
    await tx
      .update(users)
      .set({
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.user_id));
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.userId, row.user_id));
  });
}

/** Purge old login attempts and expired auth tokens (best-effort maintenance). */
export async function purgeAuthArtifacts(database: Db): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  await db(database).delete(loginAttempts).where(lt(loginAttempts.createdAt, cutoff));
  await db(database)
    .delete(refreshTokens)
    .where(or(lt(refreshTokens.expiresAt, new Date()), sql`revoked_at is not null and revoked_at < ${cutoff}`));
  await db(database)
    .delete(emailVerificationTokens)
    .where(or(lt(emailVerificationTokens.expiresAt, new Date()), sql`used_at is not null`));
  await db(database)
    .delete(passwordResetTokens)
    .where(or(lt(passwordResetTokens.expiresAt, new Date()), sql`used_at is not null`));
}
