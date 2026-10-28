import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto";

const key = randomBytes(32);

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips", () => {
    const token = "ya29.a0AfH6SMB-secret/token+with=odd~chars";
    expect(decrypt(encrypt(token, key), key)).toBe(token);
  });
  it("never produces the same ciphertext twice (random IV)", () => {
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });
  it("does not contain the plaintext", () => {
    expect(encrypt("super-secret-token", key)).not.toContain("super-secret-token");
  });
  it("rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = encrypt("hello", key).split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 0xff;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64")].join(":"), key)).toThrow();
  });
  it("rejects the wrong key", () => {
    expect(() => decrypt(encrypt("hello", key), randomBytes(32))).toThrow();
  });
  it("rejects malformed payloads", () => {
    expect(() => decrypt("not-a-payload", key)).toThrow();
  });
});
