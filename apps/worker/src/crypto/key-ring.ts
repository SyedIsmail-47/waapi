import { parseEncryptionKeyMaterial } from "./aes.js";

export class EncryptionKeyRing {
  private readonly keys: Map<number, Buffer>;

  constructor(
    private readonly currentVersion: number,
    keys: Map<number, Buffer>,
  ) {
    if (!keys.has(currentVersion)) {
      throw new Error(`AUTH_STATE_KEY_VERSION ${currentVersion} missing from key ring`);
    }
    for (const [v, k] of keys) {
      if (k.length !== 32) {
        throw new Error(`Key version ${v} is not exactly 32 bytes`);
      }
    }
    this.keys = keys;
  }

  get current(): { version: number; key: Buffer } {
    return { version: this.currentVersion, key: this.keys.get(this.currentVersion)! };
  }

  get(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new Error(`No encryption key for version ${version}`);
    }
    return key;
  }
}

/** Build ring from current key + optional JSON map `{"1":"<base64|hex>",...}`. */
export function buildKeyRing(args: {
  currentVersion: number;
  currentKeyRaw: string;
  ringJson?: string;
}): EncryptionKeyRing {
  const map = new Map<number, Buffer>();
  map.set(args.currentVersion, parseEncryptionKeyMaterial(args.currentKeyRaw));
  if (args.ringJson?.trim()) {
    const parsed = JSON.parse(args.ringJson) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) {
      map.set(Number(k), parseEncryptionKeyMaterial(v));
    }
  }
  return new EncryptionKeyRing(args.currentVersion, map);
}
