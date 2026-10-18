/**
 * WebCrypto-based Kalshi RSA-PSS request signer.
 * Kalshi requires: KALSHI-ACCESS-KEY (KEY ID), KALSHI-ACCESS-SIGNATURE (base64
 * RSA-PSS-SHA256 of `${timestampMs}${METHOD}${path}`), KALSHI-ACCESS-TIMESTAMP.
 */

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function importKey(pem: string): Promise<CryptoKey> {
  const buf = pemToArrayBuffer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    buf,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return key;
}

export async function signRequest(
  privateKeyPem: string,
  method: string,
  path: string
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const key = await importKey(privateKeyPem);
  const sigBuf = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    new TextEncoder().encode(message)
  );
  return { timestamp, signature: bufToBase64(sigBuf) };
}
