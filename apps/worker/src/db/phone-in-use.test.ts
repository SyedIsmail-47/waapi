import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import { accounts, sessions } from "./schema.js";
import { updateSessionStatus } from "./sessions.js";

describe("WP-N PHONE_IN_USE", () => {
  let database: Db;

  beforeAll(() => {
    database = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("maps unique phone conflict to lastError PHONE_IN_USE", async () => {
    const a1 = crypto.randomUUID();
    const a2 = crypto.randomUUID();
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    await database.db.insert(accounts).values([
      { id: a1, name: "phone-a" },
      { id: a2, name: "phone-b" },
    ]);
    await database.db.insert(sessions).values([
      { id: s1, accountId: a1, name: "s1", status: "connected", phoneNumber: "+14155550100" },
      { id: s2, accountId: a2, name: "s2", status: "connecting" },
    ]);

    const updated = await updateSessionStatus(database.db, a2, s2, "connected", {
      phoneNumber: "+14155550100",
    });
    expect(updated?.lastError).toBe("PHONE_IN_USE");
    expect(updated?.status).toBe("error");

    await database.db.delete(accounts).where(inArray(accounts.id, [a1, a2]));
  });
});
