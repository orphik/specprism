import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION_PREFIX = "v1";

function deriveKeyBuffer(rawKeyMaterial: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(rawKeyMaterial)) {
    return Buffer.from(rawKeyMaterial, "hex");
  }
  return createHash("sha256").update(rawKeyMaterial, "utf8").digest();
}

export function encryptSecret(plaintext: string, encryptionKey: string): string {
  if (!encryptionKey || encryptionKey.length < 16) {
    throw new Error("Encryption key must be at least 16 characters.");
  }
  const key = deriveKeyBuffer(encryptionKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptSecret(envelope: string, encryptionKey: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new Error("Unsupported or malformed encrypted secret envelope.");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted secret segments.");
  }
  const key = deriveKeyBuffer(encryptionKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
