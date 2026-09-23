// --- TWO-STEP VERIFICATION (authenticator-app codes, RFC 6238 TOTP) ---
//
// An account with two-step verification turned on signs in with its
// password AND a 6-digit code from an authenticator app (Google
// Authenticator, Microsoft Authenticator, 1Password, ...), or one of ten
// single-use recovery codes if the phone is lost. Admins can require it
// for every password sign-in (securityPolicy.requireMfa below), and can
// reset it for someone who lost both phone and recovery codes.
//
// Stored on the account record (UserRecord.mfa in types.ts):
//   secret     the authenticator secret, AES-GCM encrypted with a key
//              derived from ROOM_TOKEN_SECRET (so a KV dump alone doesn't
//              reveal it; rotating that secret means everyone re-enrolls)
//   lastStep   the last 30-second step a code was accepted for, so the
//              same code can't be used twice
//   recovery   SHA-256 hashes of the unused recovery codes
import { base64UrlEncode, base64UrlDecode } from './room-token.ts';
import { bytesToHex } from './users.ts';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
// Accept the previous and next step too, for phones whose clock is a bit off.
const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;
export const MFA_ISSUER = 'TeamSync';

// ---- Base32 (RFC 4648), the format authenticator apps use for secrets ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str: string): Uint8Array {
  const clean = str.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20))); // 160 bits, as RFC 4226 recommends
}

export async function totpCode(secretB32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) { counter[i] = n & 255; n = Math.floor(n / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % Math.pow(10, TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

export function currentStep(now: number): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

// Returns the step the code matched (to store as lastStep), or null.
// A step at or before lastStep is refused, so a code can't be replayed.
export async function verifyTotp(secretB32: string, code: string, now: number, lastStep?: number): Promise<number | null> {
  const digits = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const step = currentStep(now);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const s = step + d;
    if (typeof lastStep === 'number' && s <= lastStep) continue;
    if (await totpCode(secretB32, s) === digits) return s;
  }
  return null;
}

export function otpauthUri(secretB32: string, username: string): string {
  const label = encodeURIComponent(MFA_ISSUER + ':' + username);
  return 'otpauth://totp/' + label + '?secret=' + secretB32 + '&issuer=' + encodeURIComponent(MFA_ISSUER) +
    '&algorithm=SHA1&digits=' + TOTP_DIGITS + '&period=' + TOTP_STEP_SECONDS;
}

// ---- Recovery codes: 10 characters from an alphabet without look-alikes,
// shown as xxxxx-xxxxx. ~50 bits each, so a plain SHA-256 is enough to
// store them (they aren't guessable the way passwords are). ----
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function normalizeRecoveryCode(code: string): string {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
export function looksLikeRecoveryCode(code: string): boolean {
  return normalizeRecoveryCode(code).length === 10 && !/^\d+$/.test(normalizeRecoveryCode(code));
}
export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('teamsync-recovery:' + normalizeRecoveryCode(code)));
  return bytesToHex(new Uint8Array(digest));
}
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    let s = '';
    for (let j = 0; j < 10; j++) s += RECOVERY_ALPHABET[bytes[j] % RECOVERY_ALPHABET.length];
    codes.push(s.slice(0, 5) + '-' + s.slice(5));
  }
  return codes;
}

// ---- Secret encryption at rest ----
async function secretKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ROOM_TOKEN_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('teamsync-mfa'), info: new TextEncoder().encode('totp-secret-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
export async function encryptSecret(env: Env, secretB32: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await secretKey(env), new TextEncoder().encode(secretB32));
  return 'v1.' + base64UrlEncode(iv) + '.' + base64UrlEncode(new Uint8Array(ct));
}
export async function decryptSecret(env: Env, stored: string): Promise<string | null> {
  const parts = String(stored || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlDecode(parts[1]) }, await secretKey(env), base64UrlDecode(parts[2]));
    return new TextDecoder().decode(pt);
  } catch (e) { return null; }
}

// ---- Company-wide sign-in policy (KV, one record) ----
export const SECURITY_POLICY_KEY = 'security-policy';
export interface SecurityPolicy {
  // Every password sign-in must use two-step verification; someone without
  // it is walked through setting it up before they get in.
  requireMfa: boolean;
  updatedBy?: string;
  updatedAt?: number;
}
export async function getSecurityPolicy(env: Env): Promise<SecurityPolicy> {
  const raw = await env.USERS_KV.get(SECURITY_POLICY_KEY);
  let p: Partial<SecurityPolicy> = {};
  try { p = raw ? JSON.parse(raw) : {}; } catch (e) { p = {}; }
  return { requireMfa: !!p.requireMfa, updatedBy: p.updatedBy, updatedAt: p.updatedAt };
}
export async function putSecurityPolicy(env: Env, policy: SecurityPolicy): Promise<void> {
  await env.USERS_KV.put(SECURITY_POLICY_KEY, JSON.stringify(policy));
}
