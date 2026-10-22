import type { FastifyPluginAsync } from "fastify";
import {
  changePasswordBodySchema,
  createPatBodySchema,
  deleteAccountBodySchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  verifyEmailBodySchema,
} from "@waapi/shared";
import { z } from "zod";
import { getSignupsMode, isDevTokenReturnEnabled } from "../../config.js";
import {
  assertCsrfForCookieMode,
  clearAuthCookies,
  readRefreshFromRequest,
  setAuthCookies,
} from "../../lib/auth-cookies.js";
import { authRateLimitConfig } from "../../lib/auth-rate-limit.js";
import { clientIp } from "../../lib/client-ip.js";
import { sha256 } from "../../lib/crypto.js";
import { assertTurnstile } from "../../lib/turnstile.js";
import { createPat, listPats, revokePat } from "../../services/tokens.js";
import {
  changePassword,
  deleteAccount,
  forgotPassword,
  getMe,
  login,
  logoutAll,
  logoutRefresh,
  register,
  resendVerification,
  resetPassword,
  rotateRefresh,
  verifyEmail,
} from "../../services/auth.js";

const routes: FastifyPluginAsync = async (app) => {
  const tokens = (identity: Parameters<typeof app.jwt.sign>[0], refreshToken: string) => ({
    accessToken: app.jwt.sign(identity),
    refreshToken,
  });

  app.get("/signup-config", async () => ({ mode: getSignupsMode() }));

  app.post("/register", authRateLimitConfig("register"), async (request, reply) => {
    const input = registerBodySchema.parse(request.body);
    await assertTurnstile(input.turnstileToken, clientIp(request));
    const result = await register(
      app.database,
      {
        email: input.email,
        password: input.password,
        name: input.name,
        inviteCode: input.inviteCode,
      },
      clientIp(request),
    );
    const body: {
      userId: string;
      accountId: string;
      verificationToken?: string;
    } = {
      userId: result.user.id,
      accountId: result.account.id,
    };
    if (isDevTokenReturnEnabled()) {
      body.verificationToken = result.verificationToken;
    }
    return reply.code(201).send(body);
  });

  app.post("/login", authRateLimitConfig("login"), async (request, reply) => {
    const input = loginBodySchema.parse(request.body);
    await assertTurnstile(input.turnstileToken, clientIp(request));
    const result = await login(app.database, input.email, input.password, clientIp(request));
    const body = tokens(result.identity, result.refreshToken);
    setAuthCookies(reply, result.refreshToken);
    return body;
  });

  app.post("/refresh", authRateLimitConfig("refresh"), async (request, reply) => {
    refreshBodySchema.parse(request.body ?? {});
    assertCsrfForCookieMode(request);
    const refreshToken = readRefreshFromRequest(request);
    if (!refreshToken) {
      throw Object.assign(new Error("Refresh token required"), {
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    }
    const result = await rotateRefresh(app.database, refreshToken, clientIp(request));
    const body = tokens(result.identity, result.refreshToken);
    setAuthCookies(reply, result.refreshToken);
    return body;
  });

  app.post("/logout", authRateLimitConfig("refresh"), async (request, reply) => {
    assertCsrfForCookieMode(request);
    const refreshToken = readRefreshFromRequest(request);
    if (refreshToken) {
      await logoutRefresh(app.database, refreshToken);
    }
    clearAuthCookies(reply);
    return reply.code(204).send();
  });

  app.post("/verify-email", authRateLimitConfig("verify-email"), async (request, reply) => {
    await verifyEmail(app.database, verifyEmailBodySchema.parse(request.body).token);
    return reply.code(204).send();
  });

  app.post(
    "/resend-verification",
    authRateLimitConfig("resend-verification"),
    async (request, reply) => {
      const body = z
        .object({ email: z.string().email().max(320).optional() })
        .parse(request.body ?? {});
      // Dashboard (JWT) may omit email — resend for the authenticated user.
      if (request.headers.authorization?.startsWith("Bearer ") && !body.email) {
        await app.authenticate(request, reply);
        await resendVerification(app.database, undefined, {
          userId: request.identity.userId,
        });
        return reply.code(202).send();
      }
      if (!body.email) {
        throw Object.assign(new Error("Email required"), {
          statusCode: 400,
          code: "VALIDATION_ERROR",
        });
      }
      await resendVerification(app.database, body.email);
      return reply.code(202).send();
    },
  );

  app.post(
    "/change-password",
    { preHandler: app.requireAuthType("jwt") },
    async (request, reply) => {
      const input = changePasswordBodySchema.parse(request.body);
      const refresh = readRefreshFromRequest(request);
      await changePassword(
        app.database,
        request.identity.userId,
        input.currentPassword,
        input.newPassword,
        refresh ? sha256(refresh) : undefined,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/delete-account",
    { preHandler: app.requireAuthType("jwt") },
    async (request, reply) => {
      const input = deleteAccountBodySchema.parse(request.body);
      await deleteAccount(app.database, request.identity.userId, input.password);
      clearAuthCookies(reply);
      return reply.code(204).send();
    },
  );

  app.post("/forgot-password", authRateLimitConfig("forgot-password"), async (request, reply) => {
    const input = forgotPasswordBodySchema.parse(request.body);
    await assertTurnstile(input.turnstileToken, clientIp(request));
    await forgotPassword(app.database, input.email);
    return reply.code(202).send();
  });

  app.post("/reset-password", authRateLimitConfig("reset-password"), async (request, reply) => {
    const input = resetPasswordBodySchema.parse(request.body);
    await resetPassword(app.database, input.token, input.password);
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: app.requireAuthType("jwt") }, async (request) =>
    getMe(app.database, request.identity.userId),
  );

  app.post(
    "/logout-all",
    { preHandler: app.requireAuthType("jwt") },
    async (request, reply) => {
      await logoutAll(app.database, request.identity.userId);
      clearAuthCookies(reply);
      return reply.code(204).send();
    },
  );

  app.post(
    "/tokens",
    { preHandler: app.requireAuthType("jwt") },
    async (request, reply) => {
      const input = createPatBodySchema.parse(request.body);
      return reply
        .code(201)
        .send(
          await createPat(
            app.database,
            request.identity.userId,
            request.identity.accountId,
            input.name,
          ),
        );
    },
  );

  app.get("/tokens", { preHandler: app.requireAuthType("jwt") }, async (request) =>
    listPats(app.database, request.identity.accountId),
  );

  app.delete<{ Params: { id: string } }>(
    "/tokens/:id",
    { preHandler: app.requireAuthType("jwt") },
    async (request, reply) => {
      await revokePat(app.database, request.identity.accountId, request.params.id);
      return reply.code(204).send();
    },
  );
};

export default routes;
