import { createHash } from 'node:crypto';

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MIME_TYPES = Object.freeze(['application/pdf', 'image/png', 'image/jpeg']);
const JSON_LIMIT = 32 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class StorageError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status, message) => { throw new StorageError(code, status, message); };

function configuration(env) {
  const originText = env.SUPABASE_URL;
  const bucket = env.SUPABASE_STORAGE_BUCKET;
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const url = new URL(originText);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
        url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket)) return null;
    if (typeof key !== 'string' || key.length > 4096 || /\s/.test(key)) return null;
    const secret = /^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key);
    if (!secret) {
      const parts = key.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (claims.role !== 'service_role') return null;
    }
    return { origin: url.origin, bucket, key, secret };
  } catch { return null; }
}

// This reports environment completeness, not a successful provider connection.
export function storageStatus(env = process.env) {
  const config = configuration(env);
  return config ? { configured: true, origin: config.origin, bucket: config.bucket } :
    { configured: false, origin: null, bucket: null };
}

function context(options = {}) {
  const config = configuration(options.env ?? process.env);
  if (!config) fail('STORAGE_CONFIG', 503, 'Private evidence storage is not configured.');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    fail('STORAGE_CONFIG', 503, 'Private evidence storage is not configured.');
  }
  return { config, timeoutMs, fetchImpl: options.fetchImpl ?? fetch };
}

function objectPath(path, prefix) {
  if (typeof path !== 'string' || path.length > 300) fail('STORAGE_PATH', 422, 'Invalid evidence reference.');
  const parts = path.split('/');
  if (parts.length !== 4 || !['quarantine', 'evidence'].includes(parts[0]) ||
      (prefix && parts[0] !== prefix) || !parts.slice(1, 3).every(part => /^[A-Za-z0-9_-]{1,80}$/.test(part)) ||
      !UUID.test(parts[3])) fail('STORAGE_PATH', 422, 'Invalid evidence reference.');
  return path;
}

async function providerRequest(ctx, route, { method = 'GET', json, bytes, mime, maxBytes = JSON_LIMIT, missingStatus = 502, missingReturnsNull = false, discardSuccess = false } = {}) {
  const controller = new AbortController();
  let reader;
  let response;
  let expired = false;
  const deadline = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new StorageError('STORAGE_TIMEOUT', 504, 'Private evidence storage timed out.')), { once: true });
  });
  const timer = setTimeout(() => { expired = true; controller.abort(); }, ctx.timeoutMs);
  try {
    const headers = { apikey: ctx.config.key, Accept: bytes ? 'application/json' : '*/*' };
    if (!ctx.config.secret) headers.Authorization = `Bearer ${ctx.config.key}`;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (bytes) {
      headers['Content-Type'] = mime;
      headers['x-upsert'] = 'false';
      headers['Cache-Control'] = 'max-age=0';
    }
    if (route.startsWith('/object/upload/sign/')) headers['x-upsert'] = 'false';
    response = await Promise.race([
      ctx.fetchImpl(`${ctx.config.origin}/storage/v1${route}`, {
        method, headers, body: bytes ?? (json === undefined ? undefined : JSON.stringify(json)),
        redirect: 'error', signal: controller.signal,
      }), deadline,
    ]);
    if (!response.ok) {
      if (response.status === 404 && missingReturnsNull) return null;
      if (response.status === 404 && missingStatus !== 502) fail('STORAGE_NOT_FOUND', missingStatus, 'Uploaded evidence was not found.');
      if (response.status === 409) fail('STORAGE_CONFLICT', 409, 'The evidence destination already exists.');
      fail('STORAGE_UPSTREAM', 502, 'Private evidence storage could not complete the request.');
    }
    if (discardSuccess) return Buffer.alloc(0);
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      fail('STORAGE_SIZE', maxBytes === MAX_EVIDENCE_BYTES ? 413 : 502, 'The storage response exceeds the allowed size.');
    }
    if (!response.body) return Buffer.alloc(0);
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) fail('STORAGE_SIZE', maxBytes === MAX_EVIDENCE_BYTES ? 413 : 502, 'The storage response exceeds the allowed size.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (expired) fail('STORAGE_TIMEOUT', 504, 'Private evidence storage timed out.');
    fail('STORAGE_UPSTREAM', 502, 'Private evidence storage could not complete the request.');
  } finally {
    clearTimeout(timer);
    // Do not await cancellation: a faulty upstream stream must not hold the request open.
    if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
    else response?.body?.cancel().catch(() => {});
  }
}

async function providerJSON(ctx, route, options) {
  const bytes = await providerRequest(ctx, route, options);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('STORAGE_RESPONSE', 502, 'Private evidence storage returned an invalid response.'); }
}

async function assertPrivateBucket(ctx) {
  const bucket = await providerJSON(ctx, `/bucket/${ctx.config.bucket}`);
  const types = bucket?.allowed_mime_types;
  if (bucket?.id !== ctx.config.bucket || bucket.public !== false ||
      Number(bucket.file_size_limit) !== MAX_EVIDENCE_BYTES || !Array.isArray(types) ||
      types.length !== EVIDENCE_MIME_TYPES.length || !EVIDENCE_MIME_TYPES.every(type => types.includes(type))) {
    fail('STORAGE_BUCKET', 503, 'Evidence storage must use a private bucket limited to PDF, PNG and JPEG files of at most 5 MiB.');
  }
  return { private: true, maxBytes: MAX_EVIDENCE_BYTES, mimeTypes: [...EVIDENCE_MIME_TYPES] };
}

export async function verifyStorageConfiguration(options = {}) {
  return assertPrivateBucket(context(options));
}

function signedURL(ctx, raw, route) {
  if (typeof raw !== 'string' || raw.length > 20_000) fail('STORAGE_RESPONSE', 502, 'Private evidence storage returned an invalid response.');
  let url;
  try {
    url = new URL(raw.startsWith('/object/') ? `${ctx.config.origin}/storage/v1${raw}` : raw, ctx.config.origin);
  } catch { fail('STORAGE_RESPONSE', 502, 'Private evidence storage returned an invalid response.'); }
  if (url.origin !== ctx.config.origin || url.username || url.password || url.hash ||
      url.pathname !== `/storage/v1${route}` || url.searchParams.getAll('token').length !== 1 ||
      !url.searchParams.get('token') || [...url.searchParams.keys()].some(key => key !== 'token')) {
    fail('STORAGE_RESPONSE', 502, 'Private evidence storage returned an invalid response.');
  }
  return url;
}

export async function createUploadGrant(options) {
  const ctx = context(options);
  const path = objectPath(options.path, 'quarantine');
  await assertPrivateBucket(ctx);
  const route = `/object/upload/sign/${ctx.config.bucket}/${path}`;
  const result = await providerJSON(ctx, route, { method: 'POST', json: {} });
  const url = signedURL(ctx, result?.url, route);
  return { url: url.toString(), token: url.searchParams.get('token'), path, method: 'PUT',
    headers: { 'x-upsert': 'false' }, expiresIn: 7200 };
}

function detectedMime(bytes) {
  if (bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  fail('STORAGE_FILE_TYPE', 422, 'Evidence must contain a PDF, PNG or JPEG file.');
}

async function readEvidence(ctx, options) {
  const path = objectPath(options.path);
  if (options.expectedMime !== undefined && !EVIDENCE_MIME_TYPES.includes(options.expectedMime)) {
    fail('STORAGE_FILE_TYPE', 422, 'Choose a PDF, PNG or JPEG evidence file.');
  }
  if (options.expectedSize !== undefined && (!Number.isInteger(options.expectedSize) || options.expectedSize < 1 || options.expectedSize > MAX_EVIDENCE_BYTES)) {
    fail('STORAGE_SIZE', 422, 'Evidence must be between 1 byte and 5 MiB.');
  }
  const bytes = await providerRequest(ctx, `/object/authenticated/${ctx.config.bucket}/${path}`, {
    maxBytes: MAX_EVIDENCE_BYTES, missingStatus: 404,
  });
  const mime = detectedMime(bytes);
  if ((options.expectedSize !== undefined && bytes.length !== options.expectedSize) ||
      (options.expectedMime !== undefined && mime !== options.expectedMime)) {
    fail('STORAGE_METADATA', 422, 'The uploaded evidence does not match the selected file.');
  }
  return { bytes, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function verifyStoredEvidence(options) {
  const ctx = context(options);
  await assertPrivateBucket(ctx);
  const { bytes, ...metadata } = await readEvidence(ctx, options);
  return metadata;
}

// Authorization, intent expiry and the pending->verifying claim belong to the caller.
// Promote the bytes we verified, never a later copy of mutable quarantine content.
export async function finalizeStoredEvidence(options) {
  const ctx = context(options);
  const path = objectPath(options.path, 'quarantine');
  const finalPath = objectPath(options.finalPath, 'evidence');
  const source = path.split('/');
  const target = finalPath.split('/');
  if (source[1] !== target[1] || source[2] !== target[2] || source[3] === target[3] ||
      options.expectedMime === undefined || options.expectedSize === undefined) {
    fail('STORAGE_PATH', 422, 'Invalid evidence finalization.');
  }
  await assertPrivateBucket(ctx);
  const { bytes, ...metadata } = await readEvidence(ctx, options);
  await providerRequest(ctx, `/object/${ctx.config.bucket}/${finalPath}`, {
    method: 'POST', bytes, mime: metadata.mime,
  });
  // Retain success even if cleanup fails. Quarantine can never be used as ready proof.
  try { await removeWithContext(ctx, path); } catch {}
  return { ...metadata, path: finalPath };
}

export async function createDownloadGrant(options) {
  const ctx = context(options);
  const path = objectPath(options.path, 'evidence');
  const expiresIn = options.expiresIn ?? 60;
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 300) {
    fail('STORAGE_EXPIRY', 422, 'Download links must expire within five minutes.');
  }
  const name = options.downloadName ?? 'evidence';
  if (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(name)) {
    fail('STORAGE_FILENAME', 422, 'Invalid evidence filename.');
  }
  await assertPrivateBucket(ctx);
  const route = `/object/sign/${ctx.config.bucket}/${path}`;
  const result = await providerJSON(ctx, route, { method: 'POST', json: { expiresIn } });
  const url = signedURL(ctx, result?.signedURL, route);
  if (!options.inline) url.searchParams.set('download', name);
  return { url: url.toString(), expiresIn };
}

async function removeWithContext(ctx, path) {
  await providerRequest(ctx, `/object/${ctx.config.bucket}`, { method: 'DELETE', json: { prefixes: [objectPath(path)] } });
}

export async function removeStoredEvidence(options) {
  return removeWithContext(context(options), options.path);
}

export async function deleteStoredEvidenceAndVerify(options) {
  const ctx = context(options);
  const path = objectPath(options.path);
  await removeWithContext(ctx, path);
  const remaining = await providerRequest(ctx, `/object/${ctx.config.bucket}/${path}`, {
    method: 'HEAD', missingReturnsNull: true, discardSuccess: true,
  });
  if (remaining !== null) fail('STORAGE_DELETE_PENDING', 502, 'Evidence deletion could not yet be verified.');
  return { deleted: true };
}
