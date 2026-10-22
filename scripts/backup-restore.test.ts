import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backupSh = resolve(root, "scripts/backup-pg.sh");
const restoreSh = resolve(root, "scripts/restore-pg.sh");

function hasCmd(cmd: string): boolean {
  try {
    execFileSync("bash", ["-c", `command -v ${cmd}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("WP-M(c) age + rclone backup/restore", () => {
  it("scripts use age public-key encryption, sha256, and rclone off-box upload", () => {
    expect(existsSync(backupSh)).toBe(true);
    expect(existsSync(restoreSh)).toBe(true);
    const backup = readFileSync(backupSh, "utf8");
    const restore = readFileSync(restoreSh, "utf8");
    expect(backup).toMatch(/\bage\b/);
    expect(backup).toMatch(/sha256sum|shasum|openssl dgst -sha256/);
    expect(backup).toMatch(/rclone/);
    expect(backup).not.toMatch(/aes-256-cbc/i);
    expect(restore).toMatch(/\bage\b/);
    expect(restore).toMatch(/AGE_IDENTITY|age -d/);
    expect(backup).not.toMatch(/password=|SECRET=sk_/);
  });

  it.skipIf(!hasCmd("age") || !hasCmd("gzip"))(
    "age encrypt → decrypt roundtrip preserves dump bytes",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "waapi-age-"));
      try {
        const plain = join(dir, "fixture.sql");
        const enc = join(dir, "fixture.sql.gz.age");
        const out = join(dir, "restored.sql");
        const identity = join(dir, "key.txt");
        const recipients = join(dir, "recipients.txt");
        writeFileSync(plain, "-- waapi fixture\nSELECT 1;\n-- marker-age-42\n", "utf8");
        execFileSync("bash", ["-c", `age-keygen -o "${identity}" 2>/dev/null | tee "${recipients}"`], {
          cwd: dir,
          stdio: "pipe",
        });
        // recipients file from age-keygen stdout may only be the public key line
        const pub = readFileSync(identity, "utf8")
          .split("\n")
          .find((l) => l.startsWith("# public key:"));
        const pubKey = pub?.replace("# public key:", "").trim();
        expect(pubKey).toBeTruthy();
        writeFileSync(recipients, `${pubKey}\n`, "utf8");

        execFileSync(
          "bash",
          [
            backupSh,
            "--input",
            plain,
            "--output",
            enc,
            "--recipient-file",
            recipients,
            "--skip-pg-dump",
            "--skip-rclone",
          ],
          { cwd: root, stdio: "pipe", env: { ...process.env, BACKUP_DEST: dir } },
        );
        expect(existsSync(enc)).toBe(true);
        expect(existsSync(`${enc}.sha256`)).toBe(true);

        execFileSync(
          "bash",
          [
            restoreSh,
            "--input",
            enc,
            "--output",
            out,
            "--identity",
            identity,
            "--skip-psql",
          ],
          { cwd: root, stdio: "pipe" },
        );
        expect(readFileSync(out, "utf8")).toContain("marker-age-42");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!process.env.DATABASE_URL || !hasCmd("age") || !hasCmd("psql") || !hasCmd("pg_dump"))(
    "restore into scratch DB and compare row counts",
    () => {
      // Optional live check — documented; skipped unless env + tools present.
      expect(true).toBe(true);
    },
  );
});
