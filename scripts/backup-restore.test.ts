import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backupSh = resolve(root, "scripts/backup-pg.sh");
const restoreSh = resolve(root, "scripts/restore-pg.sh");

function shAvailable(): boolean {
  try {
    execFileSync("bash", ["-c", "command -v openssl && command -v gzip"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("WP-L encrypted backup/restore", () => {
  it("scripts exist and document off-box storage", () => {
    expect(existsSync(backupSh)).toBe(true);
    expect(existsSync(restoreSh)).toBe(true);
    const backup = readFileSync(backupSh, "utf8");
    const restore = readFileSync(restoreSh, "utf8");
    expect(backup).toMatch(/openssl|AES-256/i);
    expect(backup).toMatch(/OFFBOX|off-box|BACKUP_DEST/i);
    expect(restore).toMatch(/openssl|AES-256/i);
    expect(backup).not.toMatch(/password=|SECRET=sk_/);
  });

  it.skipIf(!shAvailable())("encrypt → decrypt roundtrip preserves dump bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "waapi-bak-"));
    try {
      const plain = join(dir, "fixture.sql");
      const enc = join(dir, "fixture.sql.gz.enc");
      const out = join(dir, "restored.sql");
      const passphrase = "test-backup-passphrase-not-a-prod-secret";
      writeFileSync(plain, "-- waapi fixture\nSELECT 1;\n-- marker-xyz-42\n", "utf8");

      execFileSync(
        "bash",
        [
          backupSh,
          "--input",
          plain,
          "--output",
          enc,
          "--passphrase",
          passphrase,
          "--skip-pg-dump",
        ],
        { cwd: root, stdio: "pipe", env: { ...process.env, BACKUP_DEST: dir } },
      );
      expect(existsSync(enc)).toBe(true);

      execFileSync(
        "bash",
        [restoreSh, "--input", enc, "--output", out, "--passphrase", passphrase, "--skip-psql"],
        { cwd: root, stdio: "pipe" },
      );
      const restored = readFileSync(out, "utf8");
      expect(restored).toContain("marker-xyz-42");
      expect(restored).not.toContain(passphrase);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
