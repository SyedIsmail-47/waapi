import { describe, expect, it } from "vitest";
import { nextBackoffMs } from "./reconnect.js";

describe("nextBackoffMs", () => {
  it("stays within exponential cap", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const ms = nextBackoffMs({ attempt, baseMs: 1000, maxMs: 8000 });
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(8000);
    }
  });
});
