import { describe, expect, it } from "vitest";
import { mapDisconnectReason } from "../session/disconnect-reason.js";

/**
 * Documents the single logout path contract:
 * Baileys close with logged_out → emit `loggedOut` only (manager wipes/status).
 * Client must NOT also emit status "logged_out" (avoids dual handlers).
 */
describe("single logout path", () => {
  it("maps 401 exclusively to logged_out action (manager listens on loggedOut)", () => {
    expect(mapDisconnectReason(401)).toEqual({ kind: "logged_out" });
  });
});
