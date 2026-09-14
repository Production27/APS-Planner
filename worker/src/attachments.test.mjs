import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeInlineImageType, handleAttachmentUpload, handleAttachmentDelete, MAX_ATTACHMENT_SIZE_BYTES } from './attachments.ts';
import { signRoomToken } from './room-token.ts';

function makeFakeEnv() {
  const objects = new Map();
  return {
    ROOM_TOKEN_SECRET: 'test-secret',
    BACKUP_BUCKET: {
      async put(key, body, opts) { objects.set(key, { body, opts }); },
      async get(key) { return objects.has(key) ? objects.get(key) : null; },
      async delete(key) { objects.delete(key); }
    },
    _objects: objects
  };
}

async function tokenFor(env, role) {
  return signRoomToken(env.ROOM_TOKEN_SECRET, { username: 'alice', displayName: 'Alice', role, assignedProjectId: null });
}

function makeUploadRequest(token, contentLength) {
  return {
    headers: {
      get(name) {
        if (name === 'X-Aps-Token') return token;
        if (name === 'Content-Length') return contentLength === undefined ? null : String(contentLength);
        return null;
      }
    },
    body: 'fake-file-bytes'
  };
}

test('isSafeInlineImageType accepts ordinary image types', () => {
  assert.equal(isSafeInlineImageType('image/png'), true);
  assert.equal(isSafeInlineImageType('image/jpeg'), true);
});

test('isSafeInlineImageType rejects image/svg+xml (the stored-XSS vector)', () => {
  assert.equal(isSafeInlineImageType('image/svg+xml'), false);
});

test('isSafeInlineImageType rejects non-image types and malformed input', () => {
  assert.equal(isSafeInlineImageType('text/html'), false);
  assert.equal(isSafeInlineImageType('application/octet-stream'), false);
  assert.equal(isSafeInlineImageType(''), false);
  assert.equal(isSafeInlineImageType(null), false);
  assert.equal(isSafeInlineImageType(undefined), false);
});

test('handleAttachmentUpload rejects a viewer-tier caller (uploading is a content edit, same floor as upsertCard)', async () => {
  const env = makeFakeEnv();
  const token = await tokenFor(env, 'viewer');
  const url = new URL('https://x/attachments/upload?name=photo.png&type=image/png');
  const res = await handleAttachmentUpload(makeUploadRequest(token), env, {}, url);
  assert.equal(res.status, 403);
});

test('handleAttachmentUpload rejects an unauthenticated request', async () => {
  const env = makeFakeEnv();
  const url = new URL('https://x/attachments/upload?name=photo.png&type=image/png');
  const res = await handleAttachmentUpload(makeUploadRequest('garbage-token'), env, {}, url);
  assert.equal(res.status, 401);
});

test('handleAttachmentUpload rejects a declared Content-Length over the 25MB cap', async () => {
  const env = makeFakeEnv();
  const token = await tokenFor(env, 'editor');
  const url = new URL('https://x/attachments/upload?name=photo.png&type=image/png');
  const res = await handleAttachmentUpload(makeUploadRequest(token, MAX_ATTACHMENT_SIZE_BYTES + 1), env, {}, url);
  assert.equal(res.status, 413);
});

test('handleAttachmentUpload accepts an editor-tier caller within the size cap and stores the file', async () => {
  const env = makeFakeEnv();
  const token = await tokenFor(env, 'editor');
  const url = new URL('https://x/attachments/upload?name=photo.png&type=image/png');
  const res = await handleAttachmentUpload(makeUploadRequest(token, 1024), env, {}, url);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.key.startsWith('attachments/'));
  assert.ok(env._objects.has(data.key));
});

test('handleAttachmentDelete rejects a viewer-tier caller (deleting is a content edit, same floor as upsertCard)', async () => {
  const env = makeFakeEnv();
  env._objects.set('attachments/x.png', { body: 'x' });
  const token = await tokenFor(env, 'viewer');
  const res = await handleAttachmentDelete({ json: async () => ({ token, key: 'attachments/x.png' }) }, env, {});
  assert.equal(res.status, 403);
  assert.ok(env._objects.has('attachments/x.png'));
});

test('handleAttachmentDelete allows an editor-tier caller to delete', async () => {
  const env = makeFakeEnv();
  env._objects.set('attachments/x.png', { body: 'x' });
  const token = await tokenFor(env, 'editor');
  const res = await handleAttachmentDelete({ json: async () => ({ token, key: 'attachments/x.png' }) }, env, {});
  assert.equal(res.status, 200);
  assert.ok(!env._objects.has('attachments/x.png'));
});
