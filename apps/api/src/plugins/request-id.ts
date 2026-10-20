import fp from "fastify-plugin";

export default fp(async (app) => {
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
});
