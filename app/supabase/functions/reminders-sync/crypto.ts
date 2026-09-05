// AES-GCM wrapper (Web Crypto) for the stored app-specific password.
// Key: 32 random bytes, base64, kept only as the ICLOUD_KEY function secret.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = unb64(keyB64);
  if (raw.length !== 32) throw new Error('ICLOUD_KEY must be 32 bytes, base64 encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Returns "v1.<iv>.<ciphertext>" (base64 parts). */
export async function encrypt(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function decrypt(keyB64: string, blob: string): Promise<string> {
  const [v, ivB64, ctB64] = blob.split('.');
  if (v !== 'v1' || !ivB64 || !ctB64) throw new Error('Unrecognised secret format');
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
  return dec.decode(pt);
}

export function randomKeyB64(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
