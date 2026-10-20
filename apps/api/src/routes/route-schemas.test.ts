import { describe, expect, it } from "vitest";
import { routeResponseSchemas } from "./response-schemas.js";
import { sessionDtoSchema, sessionStatusResponseSchema, sendMessageResponseSchema } from "@waapi/shared";

describe("response schemas", () => {
  it("covers core session/send shapes without nodeId or authKeyVersion", () => {
    const sample = {
      id: "00000000-0000-4000-8000-000000000001",
      accountId: "00000000-0000-4000-8000-000000000002",
      name: "n",
      status: "connected" as const,
      phoneNumber: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(sessionDtoSchema.parse(sample)).not.toHaveProperty("nodeId");
    expect(sessionDtoSchema.parse(sample)).not.toHaveProperty("authKeyVersion");
    expect(
      sessionStatusResponseSchema.parse({
        id: sample.id,
        status: "need_scan",
        phoneNumber: null,
        lastError: "SESSION_NOT_CONNECTED",
        qr: null,
      }),
    ).not.toHaveProperty("nodeId");
    expect(sendMessageResponseSchema.parse({ id: sample.id, status: "queued" })).toBeTruthy();
  });

  it("lists a schema entry for every API route pattern", () => {
    const keys = new Set(routeResponseSchemas.map((r) => `${r.method} ${r.url}`));
    expect(keys.has("DELETE /api/v1/sessions/:id")).toBe(true);
    expect(keys.has("POST /api/v1/send-message")).toBe(true);
    expect(keys.has("POST /api/v1/sessions/:id/webhook/deliveries/:deliveryId/replay")).toBe(true);
    expect(routeResponseSchemas.length).toBeGreaterThanOrEqual(25);
  });
});
