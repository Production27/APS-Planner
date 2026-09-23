import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode, base32Decode, totpCode, verifyTotp, currentStep, otpauthUri,
  encryptSecret, decryptSecret, generateRecoveryCodes, looksLikeRecoveryCode, TOTP_STEP_SECONDS
} from './mfa.ts';
import { handleAuth, handleAuthMfa } from './auth.ts';
import {
  handleMfaSetup, handleMfaEnable, handleMfaDisable, handleMfaStatus, handleMfaRecoveryCodes,
  handleUsersResetMfa, handleSecurityPolicy
} from './mfa-handlers.ts';
import { hashPasswordPBKDF2, genSaltHex, resolveIdentityFromToken } from './users.ts';

// ---- building blocks ----

test('TOTP matches the RFC 6238 SHA-1 test vectors (last 6 digits)', async () => {
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
  assert.equal(await totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.equal(await totpCode(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(await totpCode(secret, Math.floor(2000000000 / 30)), '279037');
});

test('base32 round-trips and ignores spaces, dashes and case', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const enc = base32Encode(bytes);
  assert.deepEqual([...base32Decode(enc.toLowerCase().replace(/(.{4})/g, '$1 '))], [...bytes]);
});

test('verifyTotp accepts the neighbouring steps, refuses older ones and replays', async () => {
  const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
  const now = Date.now();
  const step = currentStep(now);
  assert.equal(await verifyTotp(secret, await totpCode(secret, step), now), step);
  assert.equal(await verifyTotp(secret, await totpCode(secret, step - 1), now), step - 1);
  assert.equal(await verifyTotp(secret, await totpCode(secret, step - 3), now), null);
  assert.equal(await verifyTotp(secret, await totpCode(secret, step), now, step), null, 'same step twice is refused');
  assert.equal(await verifyTotp(secret, 'abcdef', now), null);
});

test('secrets are encrypted at rest and only open with the same server secret', async () => {
  const stored = await encryptSecret({ ROOM_TOKEN_SECRET: 'one' }, 'JBSWY3DPEHPK3PXP');
  assert.ok(!stored.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(await decryptSecret({ ROOM_TOKEN_SECRET: 'one' }, stored), 'JBSWY3DPEHPK3PXP');
  assert.equal(await decryptSecret({ ROOM_TOKEN_SECRET: 'two' }, stored), null);
});

test('recovery codes: ten distinct xxxxx-xxxxx codes, told apart from 6-digit codes', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  codes.forEach((c) => assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/));
  assert.ok(looksLikeRecoveryCode(codes[0].toUpperCase()));
  assert.ok(!looksLikeRecoveryCode('123456'));
});

test('otpauth link names the app and the account', () => {
  assert.equal(otpauthUri('ABC', 'bob'), 'otpauth://totp/TeamSync%3Abob?secret=ABC&issuer=TeamSync&algorithm=SHA1&digits=6&period=30');
});

// ---- the whole flow through the endpoints ----

function makeFakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    _store: store,
  };
}

async function makeEnv() {
  const kv = makeFakeKV();
  const audit = [];
  const env = {
    USERS_KV: kv,
    ROOM_TOKEN_SECRET: 'test-secret',
    APS_ROOM: {
      idFromName: (n) => ({ n }),
      get: () => ({ fetch: async (url, init) => { if (String(url).includes('/internal/audit')) audit.push(...JSON.parse(init.body).entries); return new Response('{}'); } }),
    },
  };
  for (const [username, role] of [['bob', 'editor'], ['boss', 'admin']]) {
    const salt = genSaltHex();
    kv._store.set('user:' + username, JSON.stringify({ username, displayName: username, role, assignedProjectId: null, salt, passwordHash: await hashPasswordPBKDF2('pw-' + username, salt), createdAt: 1 }));
  }
  return { env, audit };
}

function req(body, ip) {
  return { method: 'POST', headers: { get: (n) => (n === 'CF-Connecting-IP' ? (ip || '1.2.3.4') : null) }, json: async () => body };
}

async function signIn(env, username) {
  return (await handleAuth(req({ username, password: 'pw-' + username }), env, {}, undefined)).json();
}

// Turns two-step on for a signed-in account; returns the secret and codes.
async function enroll(env, token, username) {
  const setup = await (await handleMfaSetup(req({ token, password: 'pw-' + username }), env, {})).json();
  assert.ok(setup.secret);
  const enabled = await (await handleMfaEnable(req({ token, code: await totpCode(setup.secret, currentStep(Date.now())) }), env, {}, undefined)).json();
  assert.equal(enabled.recoveryCodes.length, 10);
  return { secret: setup.secret, recoveryCodes: enabled.recoveryCodes };
}

test('turning it on needs the password and a working code; the secret is stored encrypted', async () => {
  const { env, audit } = await makeEnv();
  const { token } = await signIn(env, 'bob');
  assert.equal((await handleMfaSetup(req({ token, password: 'wrong' }), env, {})).status, 403);
  const setup = await (await handleMfaSetup(req({ token, password: 'pw-bob' }), env, {})).json();
  assert.match(setup.uri, /^otpauth:\/\/totp\/TeamSync%3Abob\?secret=/);
  assert.ok(!env.USERS_KV._store.get('user:bob').includes(setup.secret), 'secret not stored in plain text');
  assert.equal((await handleMfaEnable(req({ token, code: '000000' }), env, {}, undefined)).status, 400);
  const res = await handleMfaEnable(req({ token, code: await totpCode(setup.secret, currentStep(Date.now())) }), env, {}, undefined);
  assert.equal(res.status, 200);
  const status = await (await handleMfaStatus(req({ token }), env, {})).json();
  assert.deepEqual([status.enabled, status.recoveryCodesLeft, status.required], [true, 10, false]);
  assert.ok(audit.some((e) => e.action === 'Turned on two-step verification' && e.user === 'bob'));
});

test('sign-in with two-step on: password gives a ticket, the code gives the session, codes cannot be reused', async () => {
  const { env, audit } = await makeEnv();
  const { secret } = await enroll(env, (await signIn(env, 'bob')).token, 'bob');
  const first = await signIn(env, 'bob');
  assert.equal(first.mfaRequired, true);
  assert.equal(first.token, undefined);
  assert.equal(await resolveIdentityFromToken(env, first.ticket), null, 'a ticket is not a session');

  const bad = await handleAuthMfa(req({ ticket: first.ticket, code: '000000' }), env, {}, undefined);
  assert.equal(bad.status, 401);
  assert.equal(env.USERS_KV._store.get('authfail:bob'), '1');
  assert.ok(audit.some((e) => e.action === 'Failed two-step code'));

  // The enrolment used the current step, so the next one is needed now.
  const code = await totpCode(secret, currentStep(Date.now()) + 1);
  const ok = await handleAuthMfa(req({ ticket: first.ticket, code }), env, {}, undefined);
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal((await resolveIdentityFromToken(env, data.token)).username, 'bob');
  assert.equal(env.USERS_KV._store.get('authfail:bob'), undefined, 'failures cleared after full sign-in');
  assert.ok(audit.some((e) => e.action === 'Signed in' && e.details === 'password + authenticator code'));

  const again = await handleAuthMfa(req({ ticket: (await signIn(env, 'bob')).ticket, code }), env, {}, undefined);
  assert.equal(again.status, 401, 'the same code is refused the second time');
});

test('a recovery code signs in once and is then used up', async () => {
  const { env } = await makeEnv();
  const { recoveryCodes } = await enroll(env, (await signIn(env, 'bob')).token, 'bob');
  const ok = await handleAuthMfa(req({ ticket: (await signIn(env, 'bob')).ticket, code: recoveryCodes[3].toUpperCase() }), env, {}, undefined);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).recoveryCodesLeft, 9);
  const reuse = await handleAuthMfa(req({ ticket: (await signIn(env, 'bob')).ticket, code: recoveryCodes[3] }), env, {}, undefined);
  assert.equal(reuse.status, 401);
});

test('an expired or wrong-purpose ticket is refused', async () => {
  const { env } = await makeEnv();
  const { token } = await signIn(env, 'bob');
  await enroll(env, token, 'bob');
  const res = await handleAuthMfa(req({ ticket: token, code: '123456' }), env, {}, undefined);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).restart, true);
});

test('turning it off needs password and code, and is blocked while the company requires it', async () => {
  const { env } = await makeEnv();
  const bobToken = (await signIn(env, 'bob')).token;
  const { recoveryCodes } = await enroll(env, bobToken, 'bob');
  const bossToken = (await signIn(env, 'boss')).token;
  await handleSecurityPolicy(req({ token: bossToken, requireMfa: true }), env, {});
  assert.equal((await handleMfaDisable(req({ token: bobToken, password: 'pw-bob', code: recoveryCodes[0] }), env, {})).status, 403);
  await handleSecurityPolicy(req({ token: bossToken, requireMfa: false }), env, {});
  assert.equal((await handleMfaDisable(req({ token: bobToken, password: 'wrong', code: recoveryCodes[0] }), env, {})).status, 403);
  assert.equal((await handleMfaDisable(req({ token: bobToken, password: 'pw-bob', code: '000000' }), env, {})).status, 403);
  assert.equal((await handleMfaDisable(req({ token: bobToken, password: 'pw-bob', code: recoveryCodes[0] }), env, {})).status, 200);
  assert.ok((await signIn(env, 'bob')).token, 'password alone works again');
});

test('new recovery codes replace the old ones', async () => {
  const { env } = await makeEnv();
  const token = (await signIn(env, 'bob')).token;
  const { recoveryCodes } = await enroll(env, token, 'bob');
  const fresh = await (await handleMfaRecoveryCodes(req({ token, code: recoveryCodes[0] }), env, {})).json();
  assert.equal(fresh.recoveryCodes.length, 10);
  const oldOne = await handleAuthMfa(req({ ticket: (await signIn(env, 'bob')).ticket, code: recoveryCodes[1] }), env, {}, undefined);
  assert.equal(oldOne.status, 401);
  const newOne = await handleAuthMfa(req({ ticket: (await signIn(env, 'bob')).ticket, code: fresh.recoveryCodes[1] }), env, {}, undefined);
  assert.equal(newOne.status, 200);
});

test('when the company requires it, someone without it sets it up during sign-in and then gets the session', async () => {
  const { env, audit } = await makeEnv();
  const bossToken = (await signIn(env, 'boss')).token;
  const pol = await (await handleSecurityPolicy(req({ token: bossToken, requireMfa: true }), env, {})).json();
  assert.equal(pol.policy.requireMfa, true);
  assert.ok(audit.some((e) => e.action === 'Required two-step verification for everyone'));

  const first = await signIn(env, 'bob');
  assert.equal(first.mfaSetupRequired, true);
  assert.equal(first.token, undefined);
  assert.equal(await resolveIdentityFromToken(env, first.ticket), null);
  const setup = await (await handleMfaSetup(req({ ticket: first.ticket }), env, {})).json();
  const done = await handleMfaEnable(req({ ticket: first.ticket, code: await totpCode(setup.secret, currentStep(Date.now())) }), env, {}, undefined);
  assert.equal(done.status, 200);
  const data = await done.json();
  assert.equal(data.recoveryCodes.length, 10);
  assert.equal((await resolveIdentityFromToken(env, data.token)).username, 'bob');
  assert.equal((await signIn(env, 'bob')).mfaRequired, true, 'next time it asks for a code');
});

test('only admins can change the policy or reset someone\'s two-step', async () => {
  const { env, audit } = await makeEnv();
  const bobToken = (await signIn(env, 'bob')).token;
  await enroll(env, bobToken, 'bob');
  assert.equal((await handleSecurityPolicy(req({ token: bobToken, requireMfa: true }), env, {})).status, 403);
  assert.equal((await handleUsersResetMfa(req({ token: bobToken, targetUsername: 'bob' }), env, {})).status, 403);
  const bossToken = (await signIn(env, 'boss')).token;
  assert.equal((await handleUsersResetMfa(req({ token: bossToken, targetUsername: 'bob' }), env, {})).status, 200);
  assert.ok((await signIn(env, 'bob')).token, 'bob signs in with just the password after the reset');
  assert.ok(audit.some((e) => e.action === 'Reset two-step verification' && e.item === 'bob'));
});

test('lockout also covers the code step', async () => {
  const { env } = await makeEnv();
  await enroll(env, (await signIn(env, 'bob')).token, 'bob');
  const ticket = (await signIn(env, 'bob')).ticket;
  let last;
  for (let i = 0; i < 11; i++) last = await handleAuthMfa(req({ ticket, code: '000000' }, '5.5.5.' + i), env, {}, undefined);
  assert.equal(last.status, 429);
});

test('TOTP period constant is 30 seconds (what every authenticator app assumes)', () => {
  assert.equal(TOTP_STEP_SECONDS, 30);
});
