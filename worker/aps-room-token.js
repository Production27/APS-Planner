// ==========================================
// APS Planner — Room connection token signing/verification (pure logic)
// ==========================================
//
// Replaces Liveblocks' token-minting API. The main Worker's auth endpoint
// (POST /) already checks credentials via the existing KV-backed
// resolveIdentity() — unchanged by this migration — and, on success,
// mints one of these short-lived signed tokens instead of calling out to
// Liveblocks. The Durable Object's WebSocket-upgrade handler verifies the
// signature + expiry itself, using the same secret (available to it via
// an env binding), without needing its own KV access — keeps the DO's
// connection hot path fast and free of an extra round trip.
//
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
// Deliberately not a full JWT library — this app has exactly one token
// shape and one algorithm, a hand-rolled version is a few dozen lines and
// has zero dependencies to vet.
//
// Token lifetime is long (24h default) on purpose: idle-disconnect was
// removed as part of this same migration (Durable Object hibernation
// makes staying connected free), so a real session can now legitimately
// stay open for many hours. Expiry is only ever checked at connect/
// reconnect time — an already-open, healthy socket is never force-closed
// just because its token's `exp` passed while it was hibernating.

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret, usage) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]
  );
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// payload: { username, displayName, role } — caller-supplied, already
// resolved/verified by resolveIdentity() before this is called.
async function signRoomToken(secret, payload, ttlMs) {
  const enc = new TextEncoder();
  const body = JSON.stringify(Object.assign({}, payload, { exp: Date.now() + (ttlMs || DEFAULT_TTL_MS) }));
  const bodyB64 = base64UrlEncode(enc.encode(body));
  const key = await importHmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(bodyB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return bodyB64 + '.' + sigB64;
}

// Returns the decoded payload (with exp already validated) or null if the
// token is malformed, has a bad signature, or has expired.
async function verifyRoomToken(secret, token) {
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

module.exports = { signRoomToken, verifyRoomToken, DEFAULT_TTL_MS };
if (typeof window !== 'undefined') {
  window.ApsRoomToken = module.exports;
}
