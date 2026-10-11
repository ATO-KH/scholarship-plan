import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { responseCookies } from './chair-mfa-helper.mjs';
import { sealChairMfa, openChairMfa, authMutationVersion, assertAuthMutationVersion, beginAuthMutation, finishAuthMutation } from '../server/chair-mfa.mjs';

const root = resolve(import.meta.dirname, '..'), origin = 'https://portal.example.test';
async function setup(t, delayToken = false) {
  const socket = createServer();
  await new Promise(ok => socket.listen(0, '127.0.0.1', ok));
  const port = socket.address().port;
  await new Promise(ok => socket.close(ok));
  const directory = await mkdtemp(join(tmpdir(), 'ato-chair-mfa-'));
  const child = spawn(process.execPath, ['--import', join(root, 'private-tests/mock-chapter-auth.mjs'), 'server/private.mjs'], {
    cwd: root, env: { ...process.env, APP_MODE: 'production', AUTH_MODE: 'chapter', PORT: String(port), PUBLIC_ORIGIN: origin,
      PRIVATE_DATA_DIR: directory, DATABASE_URL: '', VERCEL: '', VERCEL_ENV: '', APP_ENCRYPTION_KEY: '',
      SUPABASE_URL: 'https://chapter-test.supabase.co', SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'a'.repeat(32)}`, SUPABASE_SECRET_KEY: `sb_secret_${'b'.repeat(32)}`,
      SUPABASE_STORAGE_BUCKET: '', ROSTER_REQUIRED: 'false', ROSTER_SHEET_ID: '', TEST_PUBLIC_ROSTER: '', TEST_MFA_PREENROLLED: '', TEST_MFA_TOKEN_SIGNAL: delayToken ? join(directory, 'token-started') : '',
      CHAIR_AUTH_USER_ID: 'aab93409-383f-4d8a-b443-3d940a277153', CHAIR_ACCOUNT_EMAIL: 'chair@example.edu', CHAPTER_EMAIL_READY: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', part => stderr += part);
  t.after(async () => { child.kill(); await new Promise(ok => child.exitCode !== null ? ok() : child.once('exit', ok)); await rm(directory, { recursive: true, force: true }); });
  await new Promise((ok, reject) => {
    const deadline = setTimeout(() => reject(Error(`Server timeout: ${stderr}`)), 10000);
    child.stdout.on('data', part => { if (String(part).includes('ATO scholarship private:')) { clearTimeout(deadline); ok(); } });
    child.once('exit', code => { clearTimeout(deadline); reject(Error(`Server exited ${code}: ${stderr}`)); });
  });
  const request = async (path, body, cookie = '', csrf = '', requestOrigin = origin) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: requestOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, payload: await response.json(), cookie: responseCookies(response, cookie) };
  };
  const login = () => request('/api/auth/login', { identifier: 'chair@example.edu', password: 'correct-test-password' });
  const verify = (pending, code = '123456') => request('/api/auth/mfa/verify', { code }, pending.cookie, pending.payload.csrfToken);
  return { request, login, verify, signal: join(directory, 'token-started'), storage: () => new DatabaseSync(join(directory, 'production', 'chapter.sqlite')) };
}

test('preauthentication is authenticated encryption tied to the environment', () => {
  const env = { SUPABASE_SECRET_KEY: 'x'.repeat(40), SUPABASE_URL: 'https://test.supabase.co' };
  const value = sealChairMfa(env, { accessToken: 'private-value', csrf: 'state' });
  assert.equal(value.includes('private-value'), false);
  assert.deepEqual(openChairMfa(env, value), { accessToken: 'private-value', csrf: 'state' });
  assert.throws(() => openChairMfa({ ...env, SUPABASE_SECRET_KEY: 'y'.repeat(40) }, value), { status: 401 });
  assert.throws(() => openChairMfa(env, value.slice(0, -4) + 'aaaa'), { status: 401 });
});

test('Chair enrollment blocks all academic access until verified; replay and stale pending cookies fail', async t => {
  const c = await setup(t), pending = await c.login();
  assert.equal(pending.status, 200, JSON.stringify(pending.payload));
  assert.equal(pending.payload.mfaRequired, true);
  assert.equal(pending.payload.mfa.stage, 'enroll');
  assert.equal(pending.payload.user, undefined);
  assert.match(pending.cookie, /ato_chair_mfa=/);
  assert.equal(pending.cookie.includes('ato_session='), false);
  assert.equal((await c.request('/api/session', undefined, pending.cookie)).status, 401);
  assert.equal((await c.request('/api/submissions', undefined, pending.cookie)).status, 401);
  assert.equal((await c.request('/api/roster', undefined, pending.cookie)).status, 401);
  assert.equal((await c.request('/api/auth/mfa', undefined, pending.cookie)).payload.mfa.stage, 'enroll');
  const db = c.storage();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  const data = db.prepare("SELECT data FROM transactions WHERE kind='chair_mfa_pending'").get().data;
  for (const secret of ['TESTSETUPKEYONLY', 'fictional-test-signature', pending.payload.csrfToken]) assert.equal(data.includes(secret), false);
  db.close();
  assert.equal((await c.request('/api/auth/mfa/verify', { code: '123456' }, pending.cookie)).status, 403);
  assert.equal((await c.request('/api/auth/mfa/verify', { code: '123456' }, pending.cookie, pending.payload.csrfToken, 'https://evil.invalid')).status, 403);
  assert.equal((await c.verify(pending, '000000')).status, 422);
  const verified = await c.verify(pending);
  assert.equal(verified.status, 200, JSON.stringify(verified.payload));
  assert.equal(verified.payload.user.role, 'chair');
  assert.equal((await c.request('/api/session', undefined, verified.cookie)).status, 200);
  assert.equal((await c.request('/api/roster', undefined, verified.cookie)).status, 200);
  assert.equal((await c.verify(pending)).status, 401, 'one pending flow cannot be exchanged twice');
  const again = await c.login();
  assert.equal(again.payload.mfa.stage, 'verify', 'confirmed factor survives a lost response or later login');
  assert.equal(again.payload.mfa.secret, undefined);
  assert.equal((await c.request('/api/session', undefined, again.cookie)).status, 401);
});

test('provider failures and invalid assurance cannot mint a Chair session', async t => {
  const c = await setup(t), pending = await c.login();
  assert.equal((await c.verify(pending, '111111')).status, 503);
  assert.equal((await c.verify(pending, '333333')).status, 401, 'aal1 is not a second factor');
  assert.equal((await c.verify(pending, '222222')).status, 401, 'another authenticated identity is not the Chair');
  const db = c.storage();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();
  assert.equal((await c.verify(pending)).status, 200, 'transient failures can be retried');
});

test('attempts are limited both per pending flow and across new password logins', async t => {
  const c = await setup(t);
  let pending = await c.login();
  for (let i = 0; i < 5; i++) assert.equal((await c.verify(pending, '000000')).status, 422);
  assert.equal((await c.verify(pending)).status, 429);
  pending = await c.login();
  for (let i = 0; i < 4; i++) assert.equal((await c.verify(pending, '000000')).status, 422);
  assert.equal((await c.verify(pending)).status, 429, 'new password login cannot reset global factor limit');
});

test('abandoned enrollment is safely replaced, cancellation and expiry revoke the pending flow', async t => {
  const c = await setup(t);
  const old = await c.login(), pending = await c.login();
  assert.equal(pending.status, 200);
  assert.equal((await c.verify(old)).status, 401, 'new enrollment invalidates abandoned pending state');
  assert.equal((await c.request('/api/auth/mfa/cancel', {}, pending.cookie, pending.payload.csrfToken)).status, 200);
  assert.equal((await c.verify(pending)).status, 401);
  const expired = await c.login(), db = c.storage();
  db.prepare("UPDATE transactions SET expires=0 WHERE kind='chair_mfa_pending'").run();
  db.close();
  assert.equal((await c.verify(expired)).status, 401);
});

test('legacy Chair sessions and password reset tokens cannot bypass the second factor', async t => {
  const c = await setup(t), pending = await c.login();
  const raw = 'a'.repeat(64), id = createHash('sha256').update(raw).digest('hex'), db = c.storage();
  const chair = db.prepare("SELECT id FROM members WHERE role='chair'").get();
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(id, 'chapter', chair.id, 'old-csrf', Date.now() + 3600000);
  db.close();
  const oldCookie = `__Host-ato_session=${raw}`;
  assert.equal((await c.request('/api/session', undefined, oldCookie)).status, 401);
  assert.equal((await c.request('/api/roster', undefined, oldCookie)).status, 401);
  const reset = await c.request('/api/auth/complete', { accessToken: 'test-chair-account-token', password: 'replacement-test-password' });
  assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  assert.equal((await c.request('/api/session', undefined, reset.cookie)).status, 401);
  assert.equal((await c.verify(pending)).status, 401, 'password reset immediately revokes pending Chair enrollment');
  const updatedLogin = await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: 'replacement-test-password' });
  assert.equal(updatedLogin.payload.mfaRequired, true);
  assert.equal((await c.verify(pending)).status, 401, 'a new login replaces pre-reset pending state');
});

test('deactivating the Chair before verification prevents session issuance', async t => {
  const c = await setup(t), pending = await c.login(), db = c.storage();
  db.prepare("UPDATE members SET active=0 WHERE role='chair'").run(); db.close();
  assert.equal((await c.verify(pending)).status, 401);
});

test('enrolled Chair email reset verifies provider AAL2 before revocation or password update', async t => {
  const c = await setup(t), chair = await c.verify(await c.login());
  assert.equal(chair.status, 200);
  const body = { accessToken: 'test-chair-account-token', password: 'reset-with-authenticator-password' };
  const first = await c.request('/api/auth/complete', body);
  assert.equal(first.status, 200);
  assert.equal(first.payload.mfaRequired, true);
  assert.equal(first.payload.accessToken, undefined);
  assert.equal(first.payload.user, undefined);
  assert.equal((await c.request('/api/session', undefined, chair.cookie)).status, 200, 'asking for a code does not revoke an active session');
  for (const [code, status] of [['000000', 422], ['333333', 401], ['222222', 401], ['111111', 503]]) {
    assert.equal((await c.request('/api/auth/complete', { ...body, code })).status, status);
    assert.equal((await c.request('/api/session', undefined, chair.cookie)).status, 200, 'failed verification cannot start a password mutation');
  }
  const before = c.storage();
  assert.equal(before.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind='auth_mutation'").get().n, 0);
  before.close();
  const reset = await c.request('/api/auth/complete', { ...body, code: '123456' });
  assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  assert.equal(reset.payload.mfaRequired, undefined);
  assert.equal((await c.request('/api/session', undefined, reset.cookie)).status, 401, 'reset never mints a portal session');
  assert.equal((await c.request('/api/session', undefined, chair.cookie)).status, 401, 'completed reset revokes old portal sessions');
  assert.equal((await c.login()).status, 401, 'previous password no longer works');
  const login = await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: body.password });
  assert.equal(login.payload.mfa.stage, 'verify');
  assert.equal((await c.verify(login)).status, 200, 'the normal authenticator step is still required after a reset');
});

test('reset authenticator attempts are limited across repeated email-link submissions', async t => {
  const c = await setup(t);
  assert.equal((await c.verify(await c.login())).status, 200);
  const body = { accessToken: 'test-chair-account-token', password: 'reset-with-authenticator-password', code: '000000' };
  // The successful sign-in above used one of the shared ten attempts.
  for (let i = 0; i < 9; i++) assert.equal((await c.request('/api/auth/complete', body)).status, 422);
  assert.equal((await c.request('/api/auth/complete', { ...body, code: '123456' })).status, 429);
});


test('password mutation revokes pending MFA and sessions, blocks stale login epochs, and preserves newer fences', async () => {
  const storage = new DatabaseSync(':memory:');
  storage.exec('CREATE TABLE transactions(id TEXT PRIMARY KEY,kind TEXT,session_id TEXT,data TEXT,expires INTEGER); CREATE TABLE sessions(id TEXT,workspace TEXT,member_id TEXT);');
  const db = { prepare: sql => storage.prepare(sql.replace(/ FOR UPDATE/g, '')) };
  try {
    storage.prepare('INSERT INTO sessions VALUES (?,?,?)').run('old-session', 'chapter', 'chair-member');
    storage.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run('pending', 'chair_mfa_pending', 'chair-member', 'encrypted', Date.now() + 100000);
    storage.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run('receipt', 'chair_mfa_verified', 'old-session', '{}', Date.now() + 100000);
    const old = await authMutationVersion(db, 'chapter', 'chair-member');
    const epoch = await beginAuthMutation(db, 'chapter', 'chair-member');
    assert.equal(storage.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind LIKE 'chair_mfa_%'").get().n, 0);
    await assert.rejects(authMutationVersion(db, 'chapter', 'chair-member'), { status: 409 });
    await assert.rejects(beginAuthMutation(db, 'chapter', 'chair-member'), { status: 409 });
    await finishAuthMutation(db, 'chapter', 'chair-member', 'wrong-epoch');
    await assert.rejects(authMutationVersion(db, 'chapter', 'chair-member'), { status: 409 });
    await finishAuthMutation(db, 'chapter', 'chair-member', epoch);
    assert.equal(await authMutationVersion(db, 'chapter', 'chair-member'), epoch);
    await assert.rejects(assertAuthMutationVersion(db, 'chapter', 'chair-member', old), { status: 401 });
    await assertAuthMutationVersion(db, 'chapter', 'chair-member', epoch);
    const next = await beginAuthMutation(db, 'chapter', 'chair-member');
    await finishAuthMutation(db, 'chapter', 'chair-member', epoch);
    await assert.rejects(authMutationVersion(db, 'chapter', 'chair-member'), { status: 409 });
    await finishAuthMutation(db, 'chapter', 'chair-member', next);
  } finally { storage.close(); }
});


test('initial Chair password setup invalidates a bootstrap password login already in flight', async t => {
  const c = await setup(t, true);
  const login = c.login();
  let started = false;
  for (let i = 0; i < 200; i++) {
    try { await readFile(c.signal); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assert.equal(started, true, 'provider has verified the original password');
  const reset = await c.request('/api/auth/complete', { accessToken: 'test-chair-account-token', password: 'replacement-test-password' });
  assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  assert.equal((await login).status, 401, 'old password cannot create even a pending enrollment after setup');
  const db = c.storage();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind='chair_mfa_pending'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();
  const retry = await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: 'replacement-test-password' });
  assert.equal(retry.payload.mfaRequired, true);
});

test('a delayed first Chair login cannot skip an epoch created after another request bootstraps the account', async t => {
  const c = await setup(t, true), login = c.login();
  let started = false;
  for (let i = 0; i < 200; i++) {
    try { await readFile(c.signal); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assert.equal(started, true);
  const storage = c.storage();
  storage.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?,?)').run('chapter', 'concurrent-chair', 'Chair Office', 'chair@example.edu', 'chair', 1, 15, 1);
  storage.prepare('INSERT INTO identities VALUES (?,?,?,?)').run('chapter', 'supabase', 'aab93409-383f-4d8a-b443-3d940a277153', 'concurrent-chair');
  const db = { prepare: sql => storage.prepare(sql.replace(/ FOR UPDATE/g, '')) };
  const epoch = await beginAuthMutation(db, 'chapter', 'concurrent-chair');
  await finishAuthMutation(db, 'chapter', 'concurrent-chair', epoch);
  assert.equal((await login).status, 401, 'retry must now resolve the member and capture its current epoch');
  assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind='chair_mfa_pending'").get().n, 0);
  storage.close();
});
