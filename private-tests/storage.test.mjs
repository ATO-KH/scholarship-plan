import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MAX_EVIDENCE_BYTES, EVIDENCE_MIME_TYPES, StorageError, storageStatus, verifyStorageConfiguration,
  createUploadGrant, verifyStoredEvidence, finalizeStoredEvidence, createDownloadGrant, removeStoredEvidence, deleteStoredEvidenceAndVerify,
} from '../server/storage.mjs';

// Provider-mock tests verify our HTTP contract and trust boundaries, not deployed Supabase behavior.
const env = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-only-private-storage-key',
  SUPABASE_STORAGE_BUCKET: 'academic-evidence',
};
const path = 'quarantine/workspace/member/01bbbc31-b15a-4e7d-a28f-313ac9b76c2e';
const finalPath = 'evidence/workspace/member/0a608529-4d42-4332-a996-fca00a3ce2e0';
const pdf = Buffer.from('%PDF-1.7\nExample evidence bytes.\n%%EOF');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const bucket = { id: env.SUPABASE_STORAGE_BUCKET, public: false,
  file_size_limit: MAX_EVIDENCE_BYTES, allowed_mime_types: [...EVIDENCE_MIME_TYPES] };
const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init, headers: { 'Content-Type': 'application/json', ...init.headers },
});
const route = url => new URL(url).pathname.replace('/storage/v1', '');
const bucketURL = `/bucket/${bucket.id}`;
const uploadRoute = `/object/upload/sign/${bucket.id}/${path}`;
const finalRoute = `/object/${bucket.id}/${finalPath}`;
const downloadRoute = `/object/sign/${bucket.id}/${finalPath}`;

function provider(handler, bucketOverride = bucket) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(new URL(url).origin, env.SUPABASE_URL);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (route(url) === bucketURL) return json(bucketOverride);
    return handler(url, options);
  };
  return { fetchImpl, calls };
}
const rejects = (promise, code, status) => assert.rejects(promise, error =>
  error instanceof StorageError && error.code === code && (status === undefined || error.status === status));

test('storage configuration fails closed and never exposes the server key', () => {
  assert.equal(storageStatus(env).configured, true);
  assert.ok(!JSON.stringify(storageStatus(env)).includes(env.SUPABASE_SECRET_KEY));
  for (const bad of [
    {}, { ...env, SUPABASE_URL: 'http://test-project.supabase.co' },
    { ...env, SUPABASE_URL: 'https://test-project.supabase.co.attacker.example' },
    { ...env, SUPABASE_URL: 'https://127.0.0.1' },
    { ...env, SUPABASE_URL: 'https://user:password@test-project.supabase.co' },
    { ...env, SUPABASE_URL: env.SUPABASE_URL + '/storage/v1' },
    { ...env, SUPABASE_URL: env.SUPABASE_URL + '?secret=value' },
    { ...env, SUPABASE_STORAGE_BUCKET: '../other' },
    { ...env, SUPABASE_SECRET_KEY: 'sb_publishable_public-key-not-allowed' },
    { ...env, SUPABASE_SECRET_KEY: '' },
  ]) assert.equal(storageStatus(bad).configured, false);
});

test('secret API keys use apikey only; legacy keys must explicitly be service_role JWTs', async () => {
  const secret = provider(() => assert.fail('bucket inspection only'));
  await verifyStorageConfiguration({ env, fetchImpl: secret.fetchImpl });
  assert.equal(secret.calls[0].headers.apikey, env.SUPABASE_SECRET_KEY);
  assert.equal(secret.calls[0].headers.Authorization, undefined);
  const legacyKey = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  const legacy = provider(() => assert.fail('bucket inspection only'));
  await verifyStorageConfiguration({ env: { ...env, SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: legacyKey }, fetchImpl: legacy.fetchImpl });
  assert.equal(legacy.calls[0].headers.Authorization, `Bearer ${legacyKey}`);
  assert.equal(legacy.calls[0].headers.apikey, legacyKey);
  const anon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`;
  assert.equal(storageStatus({ ...env, SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: anon }).configured, false);
});

test('every grant requires an explicitly private bucket with exact size and MIME restrictions', async () => {
  for (const settings of [
    { ...bucket, public: true }, { ...bucket, public: undefined }, { ...bucket, public: 'false' },
    { ...bucket, file_size_limit: null }, { ...bucket, file_size_limit: MAX_EVIDENCE_BYTES + 1 },
    { ...bucket, allowed_mime_types: null }, { ...bucket, allowed_mime_types: ['image/*'] },
    { ...bucket, allowed_mime_types: [...EVIDENCE_MIME_TYPES, 'text/html'] }, { ...bucket, id: 'other-bucket' },
  ]) {
    const p = provider(() => assert.fail('unsafe bucket must not issue a grant'), settings);
    await rejects(createUploadGrant({ path, env, fetchImpl: p.fetchImpl }), 'STORAGE_BUCKET', 503);
    assert.equal(p.calls.length, 1);
  }
});

test('browser upload grant is restricted to one quarantine path and denies overwrite at signing', async () => {
  const p = provider((url, options) => {
    assert.equal(route(url), uploadRoute);
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {});
    assert.equal(options.headers['x-upsert'], 'false');
    return json({ url: `${uploadRoute}?token=temporary-upload-token` });
  });
  const grant = await createUploadGrant({ path, env, fetchImpl: p.fetchImpl });
  assert.equal(grant.url, `${env.SUPABASE_URL}/storage/v1${uploadRoute}?token=temporary-upload-token`);
  assert.equal(grant.method, 'PUT');
  assert.equal(grant.headers['x-upsert'], 'false');
  assert.equal(grant.expiresIn, 7200);
  assert.ok(!JSON.stringify(grant).includes(env.SUPABASE_SECRET_KEY));
  await rejects(createUploadGrant({ path: finalPath, env, fetchImpl: p.fetchImpl }), 'STORAGE_PATH', 422);
});

test('object references reject traversal, foreign URLs, malformed IDs and unsafe segments before network access', async () => {
  const fetchImpl = () => assert.fail('invalid paths must not contact storage');
  for (const bad of [path + '?x=1', '/' + path, path.replace('member', '..'), path.replace('member', '%2e%2e'),
    path.replace('member', 'member/extra'), 'https://attacker.example/object', path.replace('member', 'a\\b'),
    path.replace('01bbbc31-b15a-4e7d-a28f-313ac9b76c2e', 'not-a-uuid')]) {
    await rejects(createUploadGrant({ path: bad, env, fetchImpl }), 'STORAGE_PATH', 422);
  }
});

test('signed response URLs cannot redirect browser uploads to a different host, object, or endpoint', async () => {
  for (const signed of [
    `https://attacker.example/storage/v1${uploadRoute}?token=one`,
    `${uploadRoute.replace('member', 'other')}?token=one`,
    `${uploadRoute}?token=one&token=two`, `${uploadRoute}?token=one&unexpected=value`,
    `${uploadRoute}?token=one#fragment`, `${uploadRoute}?token=`,
    `/object/public/${bucket.id}/${path}?token=one`,
  ]) {
    const p = provider(() => json({ url: signed }));
    await rejects(createUploadGrant({ path, env, fetchImpl: p.fetchImpl }), 'STORAGE_RESPONSE', 502);
  }
});

test('evidence verification derives MIME and size from downloaded bytes, ignoring provider metadata', async () => {
  for (const [bytes, mime] of [[pdf, 'application/pdf'], [png, 'image/png'], [jpeg, 'image/jpeg']]) {
    const p = provider(url => {
      assert.equal(route(url), `/object/authenticated/${bucket.id}/${path}`);
      return new Response(bytes, { headers: { 'Content-Type': 'text/html' } });
    });
    const result = await verifyStoredEvidence({ path, env, expectedMime: mime, expectedSize: bytes.length, fetchImpl: p.fetchImpl });
    assert.deepEqual(result, { mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const body of [Buffer.from('<html>fake</html>'), Buffer.alloc(0), Buffer.from('%PDF')]) {
    const p = provider(() => new Response(body, { headers: { 'Content-Type': 'application/pdf' } }));
    await rejects(verifyStoredEvidence({ path, env, fetchImpl: p.fetchImpl }), 'STORAGE_FILE_TYPE', 422);
  }
});

test('actual evidence bytes must match intent MIME and size before promotion', async () => {
  for (const changed of [{ expectedMime: 'image/png', expectedSize: pdf.length }, { expectedMime: 'application/pdf', expectedSize: pdf.length + 1 }]) {
    const p = provider((url, options) => {
      assert.equal(options.method, 'GET');
      return new Response(pdf);
    });
    await rejects(finalizeStoredEvidence({ path, finalPath, env, fetchImpl: p.fetchImpl, ...changed }), 'STORAGE_METADATA', 422);
    assert.equal(p.calls.length, 2);
  }
});

test('exactly 5 MiB is accepted while missing or misleading lengths cannot bypass the byte limit', async () => {
  const limit = Buffer.alloc(MAX_EVIDENCE_BYTES);
  pdf.copy(limit);
  const p = provider(() => new Response(limit));
  assert.equal((await verifyStoredEvidence({ path, env, fetchImpl: p.fetchImpl })).size, MAX_EVIDENCE_BYTES);
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const tooLarge = provider(() => new Response(Buffer.concat([limit, Buffer.from([0])]), { headers }));
    await rejects(verifyStoredEvidence({ path, env, fetchImpl: tooLarge.fetchImpl }), 'STORAGE_SIZE', 413);
  }
  const declaredLarge = provider(() => new Response(pdf, { headers: { 'Content-Length': String(MAX_EVIDENCE_BYTES + 1) } }));
  await rejects(verifyStoredEvidence({ path, env, fetchImpl: declaredLarge.fetchImpl }), 'STORAGE_SIZE', 413);
});

test('finalization writes the exact verified bytes to a distinct immutable final key before quarantine cleanup', async () => {
  let mutableSource = Buffer.from(pdf);
  let written;
  let deleted = false;
  const p = provider((url, options) => {
    const endpoint = route(url);
    if (options.method === 'GET') {
      const response = new Response(Buffer.from(mutableSource));
      mutableSource = Buffer.from('<html>replacement uploaded after verification began</html>');
      return response;
    }
    if (options.method === 'POST') {
      assert.equal(endpoint, finalRoute);
      assert.equal(options.headers['x-upsert'], 'false');
      assert.equal(options.headers['Content-Type'], 'application/pdf');
      assert.equal(options.headers['Cache-Control'], 'max-age=0');
      written = Buffer.from(options.body);
      return json({ Key: `${bucket.id}/${finalPath}` });
    }
    assert.equal(options.method, 'DELETE');
    assert.ok(written, 'verified bytes must be durably written before cleanup');
    assert.deepEqual(JSON.parse(options.body), { prefixes: [path] });
    deleted = true;
    return json([]);
  });
  const result = await finalizeStoredEvidence({ path, finalPath, env, expectedMime: 'application/pdf', expectedSize: pdf.length, fetchImpl: p.fetchImpl });
  assert.deepEqual(written, pdf);
  assert.notDeepEqual(written, mutableSource);
  assert.equal(result.path, finalPath);
  assert.equal(result.size, pdf.length);
  assert.ok(deleted);
  assert.ok(p.calls.every(call => !route(call.url).startsWith('/object/copy')));
});

test('finalization rejects cross-owner paths, missing intent metadata, and non-distinct object IDs', async () => {
  for (const changed of [
    { finalPath: finalPath.replace('member', 'other') }, { finalPath: finalPath.replace('workspace', 'other') },
    { finalPath: path.replace('quarantine/', 'evidence/') }, { expectedMime: undefined }, { expectedSize: undefined },
  ]) {
    await rejects(finalizeStoredEvidence({ path, finalPath, env, expectedMime: 'application/pdf', expectedSize: pdf.length,
      fetchImpl: () => assert.fail('invalid finalization must not contact storage'), ...changed }), 'STORAGE_PATH', 422);
  }
});

test('existing final object is never overwritten; cleanup failure does not invalidate completed promotion', async () => {
  const conflict = provider((url, options) => options.method === 'GET' ? new Response(pdf) :
    json({ message: env.SUPABASE_SECRET_KEY }, { status: 409 }));
  await rejects(finalizeStoredEvidence({ path, finalPath, env, expectedMime: 'application/pdf', expectedSize: pdf.length, fetchImpl: conflict.fetchImpl }), 'STORAGE_CONFLICT', 409);
  assert.equal(conflict.calls.filter(call => call.method === 'DELETE').length, 0);
  const cleanupFailed = provider((url, options) => options.method === 'GET' ? new Response(pdf) :
    options.method === 'DELETE' ? json({ message: 'provider failure' }, { status: 500 }) : json({ Key: finalPath }));
  const promoted = await finalizeStoredEvidence({ path, finalPath, env, expectedMime: 'application/pdf', expectedSize: pdf.length, fetchImpl: cleanupFailed.fetchImpl });
  assert.equal(promoted.path, finalPath);
});

test('download grants use short explicit expiry, a safe attachment name, and final evidence paths only', async () => {
  const p = provider((url, options) => {
    assert.equal(route(url), downloadRoute);
    assert.deepEqual(JSON.parse(options.body), { expiresIn: 60 });
    return json({ signedURL: `${downloadRoute}?token=temporary-read-token` });
  });
  const grant = await createDownloadGrant({ path: finalPath, downloadName: 'Grade report.pdf', env, fetchImpl: p.fetchImpl });
  assert.equal(grant.expiresIn, 60);
  assert.equal(new URL(grant.url).searchParams.get('download'), 'Grade report.pdf');
  assert.ok(!JSON.stringify(grant).includes(env.SUPABASE_SECRET_KEY));
  await rejects(createDownloadGrant({ path, env, fetchImpl: p.fetchImpl }), 'STORAGE_PATH', 422);
  for (const expiresIn of [0, 301, 1.5, '60']) {
    await rejects(createDownloadGrant({ path: finalPath, expiresIn, env, fetchImpl: p.fetchImpl }), 'STORAGE_EXPIRY', 422);
  }
  for (const downloadName of ['', '../evidence.pdf', 'file\r\nHeader:value', 'a\\b.pdf']) {
    await rejects(createDownloadGrant({ path: finalPath, downloadName, env, fetchImpl: p.fetchImpl }), 'STORAGE_FILENAME', 422);
  }
});

test('timeouts cover stalled fetches and stalled response bodies; provider errors never expose secrets', async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    await rejects(verifyStorageConfiguration({ env, timeoutMs: 20, fetchImpl }), 'STORAGE_TIMEOUT', 504);
  }
  for (const fetchImpl of [
    async () => { throw new Error(env.SUPABASE_SECRET_KEY); },
    async () => json({ error: env.SUPABASE_SECRET_KEY }, { status: 401 }),
    async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } }),
    async () => new Response('invalid JSON ' + env.SUPABASE_SECRET_KEY),
  ]) {
    await assert.rejects(verifyStorageConfiguration({ env, fetchImpl }), error =>
      error instanceof StorageError && !String(error).includes(env.SUPABASE_SECRET_KEY) && !JSON.stringify(error).includes(env.SUPABASE_SECRET_KEY));
  }
});

test('provider JSON responses are bounded and delete requests are limited to one validated exact key', async () => {
  await rejects(verifyStorageConfiguration({ env, fetchImpl: async () => new Response(' '.repeat(32 * 1024 + 1)) }), 'STORAGE_SIZE', 502);
  const p = provider((url, options) => {
    assert.equal(route(url), `/object/${bucket.id}`);
    assert.equal(options.method, 'DELETE');
    assert.deepEqual(JSON.parse(options.body), { prefixes: [finalPath] });
    return json([]);
  });
  await removeStoredEvidence({ path: finalPath, env, fetchImpl: p.fetchImpl });
  assert.equal(p.calls.length, 1);
});

test('permanent deletion requires a follow-up absent-object check; authorization errors cannot prove deletion', async () => {
  for (const status of [200, 401, 403, 500]) {
    const p = provider((url, options) => options.method === 'DELETE' ? json([]) :
      new Response(null, { status }));
    await assert.rejects(deleteStoredEvidenceAndVerify({ path: finalPath, env, fetchImpl: p.fetchImpl }), StorageError);
  }
  const absent = provider((url, options) => {
    if (options.method === 'DELETE') return json([]);
    assert.equal(options.method, 'HEAD');
    assert.equal(route(url), `/object/${bucket.id}/${finalPath}`);
    return new Response(null, { status: 404 });
  });
  assert.deepEqual(await deleteStoredEvidenceAndVerify({ path: finalPath, env, fetchImpl: absent.fetchImpl }), { deleted: true });
});
