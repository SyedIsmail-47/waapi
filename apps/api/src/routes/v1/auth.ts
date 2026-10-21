import type { FastifyPluginAsync } from "fastify";
import {
  createPatBodySchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  verifyEmailBodySchema,
} from "@waapi/shared";
import { z } from "zod";
import { isDevTokenReturnEnabled } from "../../config.js";
import { authRateLimitConfig } from "../../lib/auth-rate-limit.js";
import { clientIp } from "../../lib/client-ip.js";
import { createPat, listPats, revokePat } from "../../services/tokens.js";
import {
  forgotPassword,
  login,
  logoutAll,
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

  app.post("/register", authRateLimitConfig("register"), async (request, reply) => {
    const result = await register(
      app.database,
      registerBodySchema.parse(request.body),
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

  app.post("/login", authRateLimitConfig("login"), async (request) => {
    const input = loginBodySchema.parse(request.body);
    const result = await login(app.database, input.email, input.password, clientIp(request));
    return tokens(result.identity, result.refreshToken);
  });

  app.post("/refresh", authRateLimitConfig("refresh"), async (request) => {
    const result = await rotateRefresh(
      app.database,
      refreshBodySchema.parse(request.body).refreshToken,
      clientIp(request),
    );
    return tokens(result.identity, result.refreshToken);
  });

  app.post("/verify-email", authRateLimitConfig("verify-email"), async (request, reply) => {
    await verifyEmail(app.database, verifyEmailBodySchema.parse(request.body).token);
    return reply.code(204).send();
  });

  app.post(
    "/resend-verification",
    authRateLimitConfig("resend-verification"),
    async (request, reply) => {
      const email = z.object({ email: z.string().email().max(320) }).parse(request.body).email;
      await resendVerification(app.database, email);
      return reply.code(202).send();
    },
  );

  app.post("/forgot-password", authRateLimitConfig("forgot-password"), async (request, reply) => {
    await forgotPassword(app.database, forgotPasswordBodySchema.parse(request.body).email);
    return reply.code(202).send();
  });

  app.post("/reset-password", authRateLimitConfig("reset-password"), async (request, reply) => {
    const input = resetPasswordBodySchema.parse(request.body);
    await resetPassword(app.database, input.token, input.password);
    return reply.code(204).send();
  });

  app.post(
    "/logout-all",
    { preHandler: app.requireAuthType("jwt") },
    async (request, reply) => {
      await logoutAll(app.database, request.identity.userId);
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
