import type { Db } from "@waapi/db";
import type { AuthType, RequestIdentity } from "./plugins/auth.js";
import type { Identity } from "./services/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    database: Db;
    authenticate(
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ): Promise<void>;
    requireAuthType(
      ...types: AuthType[]
    ): (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => Promise<void>;
  }
  interface FastifyRequest {
    identity: RequestIdentity;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: Identity;
    user: Identity;
  }
}
