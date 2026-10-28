import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * AES-256-GCM for OAuth tokens at rest.
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
 * Key: TOKEN_ENCRYPTION_KEY = 32 random bytes, base64 (or 64 hex chars).
 *   openssl rand -base64 32
 */
function loadKey(): Buffer {
  const { TOKEN_ENCRYPTION_KEY } = requireEnv("TOKEN_ENCRYPTION_KEY");
  const raw = TOKEN_ENCRYPTION_KEY.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new AppError("CONFIG_INVALID", "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32).", 503);
  }
  return key;
}

export function encrypt(plain: string, key: Buffer = loadKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(payload: string, key: Buffer = loadKey()): string {
  const [version, iv, tag, ct] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !ct) throw new AppError("DECRYPT_FAILED", "Stored token is malformed.", 500);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export const encryptOptional = (v: string | null | undefined) => (v ? encrypt(v) : null);
export const decryptOptional = (v: string | null | undefined) => (v ? decrypt(v) : null);
