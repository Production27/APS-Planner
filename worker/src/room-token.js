// --- ROOM TOKEN SIGNING — this file is the sole source of truth for it;
// an earlier design-iteration copy that used to live at
// worker/aps-room-token.js was removed in commit a4da847. ---

export function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function importHmacKey(secret, usage) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export async function signRoomToken(secret, payload, ttlMs) {
  const enc = new TextEncoder();
  const body = JSON.stringify(Object.assign({}, payload, { exp: Date.now() + (ttlMs || DEFAULT_TOKEN_TTL_MS) }));
  const bodyB64 = base64UrlEncode(enc.encode(body));
  const key = await importHmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(bodyB64));
  return bodyB64 + '.' + base64UrlEncode(new Uint8Array(sig));
}
export async function verifyRoomToken(secret, token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const dot = token.lastIndexOf('.');
  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!bodyB64 || !sigB64) return null;
  let sigBytes;
  try { sigBytes = base64UrlDecode(sigB64); } catch (e) { return null; }
  const enc = new TextEncoder();
  const key = await importHmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(bodyB64));
  if (!valid) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(bodyB64))); } catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}
