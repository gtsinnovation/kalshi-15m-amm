/**
 * Browser-side credential vault.
 *
 * The Kalshi RSA private key is the most sensitive thing this app holds —
 * anyone who reads it can sign trades on the user's account. This module
 * encrypts it with a passphrase using WebCrypto AES-GCM + PBKDF2 so that
 * what is persisted to localStorage is unusable without the passphrase.
 *
 * Design:
 *  - Encrypted blob = base64(salt(16) || iv(12) || ciphertext+tag)
 *  - Passphrase is stretched with PBKDF2-SHA256, 250k iterations.
 *  - Only the PEM is encrypted. keyId, env, corsProxy are non-secret and
 *    persisted in plaintext so the app shell can render and the unlock UI
 *    can show which key the user is unlocking.
 */

import type { KalshiCredentials } from "@/lib/kalshi/types";

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedCredentials {
  /** Plaintext, non-secret. */
  keyId: string;
  env: KalshiCredentials["env"];
  corsProxy: string;
  /** base64(salt || iv || ciphertext) of the PEM. */
  pemCipher: string;
  /** Format version for future migrations. */
  v: 1;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPem(pem: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)));
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const key = await deriveKey(passphrase, salt);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(pem)),
  );
  const out = new Uint8Array(salt.length + iv.length + cipher.length);
  out.set(salt, 0);
  out.set(iv, salt.length);
  out.set(cipher, salt.length + iv.length);
  return toB64(out);
}

export async function decryptPem(blobB64: string, passphrase: string): Promise<string> {
  const blob = fromB64(blobB64);
  if (blob.length < SALT_BYTES + IV_BYTES + 1) throw new Error("Vault blob too short");
  const salt = new Uint8Array(blob.slice(0, SALT_BYTES));
  const iv = new Uint8Array(blob.slice(SALT_BYTES, SALT_BYTES + IV_BYTES));
  const cipher = new Uint8Array(blob.slice(SALT_BYTES + IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("Incorrect passphrase");
  }
}

/** Compatibility helpers: never persist a vault passphrase. Clear legacy caches. */
const SESSION_KEY = "kalshi-mm-vault-pass";
export function forgetSessionPassphrase() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
}
export function rememberPassphraseForSession(_passphrase: string) { forgetSessionPassphrase(); }
export function getSessionPassphrase(): null { forgetSessionPassphrase(); return null; }
