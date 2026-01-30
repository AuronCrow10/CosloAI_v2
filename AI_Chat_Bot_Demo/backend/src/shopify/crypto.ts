import crypto from "crypto";
import { requireShopifyConfig } from "./config";

function getTokenEncryptionKey(): Buffer {
  const { tokenEncryptionKey } = requireShopifyConfig();
  const raw = tokenEncryptionKey;

  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== 32) {
    throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY must be 32 bytes");
  }
  return key;
}

export function encryptToken(plainText: string): string {
  const key = getTokenEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

export function decryptToken(payload: string): string {
  const key = getTokenEncryptionKey();
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

export function verifyShopifyHmac(queryString: string): boolean {
  const { apiSecret } = requireShopifyConfig();
  const params = new URLSearchParams(queryString);
  const provided = params.get("hmac");
  if (!provided) return false;
  params.delete("hmac");
  params.delete("signature");

  const keys = Array.from(params.keys()).sort();
  const message = keys
    .map((key) => `${key}=${encodeURIComponent(params.getAll(key).join(","))}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", apiSecret)
    .update(message)
    .digest("hex");

  const digestBuf = Buffer.from(digest, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (digestBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(digestBuf, providedBuf);
}

export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string): boolean {
  const { apiSecret } = requireShopifyConfig();
  const digest = crypto
    .createHmac("sha256", apiSecret)
    .update(rawBody)
    .digest("base64");

  const digestBuf = Buffer.from(digest, "utf8");
  const providedBuf = Buffer.from(hmacHeader, "utf8");
  if (digestBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(digestBuf, providedBuf);
}

export function generateNonce(size = 16): string {
  return crypto.randomBytes(size).toString("hex");
}
