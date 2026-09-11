// --- ROOM TOKEN SIGNING — HMAC-signs/verifies the tokens used to
// authenticate WebSocket room connections. ---

// Whatever's passed to signRoomToken() (currently always username/
// displayName/role/assignedProjectId — see auth.ts) plus the `exp` stamp
// this function always adds. Left open via the index signature since
// callers pass differently-shaped payloads depending on context.
export interface TokenPayload {
  exp: number;
  [key: string]: unknown;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export async function signRoomToken(secret: string, payload: Record<string, unknown>, ttlMs?: number): Promise<string> {
  const enc = new TextEncoder();
  const body = JSON.stringify(Object.assign({}, payload, { exp: Date.now() + (ttlMs || DEFAULT_TOKEN_TTL_MS) }));
  const bodyB64 = base64UrlEncode(enc.encode(body));
  const key = await importHmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(bodyB64));
  return bodyB64 + '.' + base64UrlEncode(new Uint8Array(sig));
}
export async function verifyRoomToken(secret: string, token: string | null | undefined): Promise<TokenPayload | null> {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const dot = token.lastIndexOf('.');
  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!bodyB64 || !sigB64) return null;
  let sigBytes: Uint8Array;
  try { sigBytes = base64UrlDecode(sigB64); } catch (e) { return null; }
  const enc = new TextEncoder();
  const key = await importHmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(bodyB64));
  if (!valid) return null;
  let payload: TokenPayload;
  try { payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(bodyB64))); } catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}
