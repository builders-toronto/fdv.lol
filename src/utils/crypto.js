export async function sha256Bytes(s) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return new Uint8Array(buf);
}

export async function deriveAesGcmKeyFromMint(mint) {
  const keyBytes = await sha256Bytes(mint);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toB64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

export async function encryptStringWithMint(mint, plaintext) {
  const key = await deriveAesGcmKeyFromMint(mint);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  return { v: 1, alg: "AES-GCM-256", ivB64: toB64(iv), dataB64: toB64(new Uint8Array(ct)) };
}

export function wrapFdvEncText({ v, alg, ivB64, dataB64 }) {
  return `FDVENC v${v}\nalg=${alg}\niv=${ivB64}\n\n${dataB64}\n`;
}