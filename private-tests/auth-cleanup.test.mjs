import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { cleanupExpiredAuth } from '../server/auth-cleanup.mjs';

test('expired authentication cleanup is bounded and preserves active flows, recovery keys and mutation fences', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ato-auth-cleanup-'));
  const db = await openDatabase({ directory, env: {} });
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  const now = 10000;
  for (const [id, kind, expires] of [
    ['recovery', 'recovery_key', 1], ['mutation', 'auth_mutation', 1],
    ['unknown', 'future_flow', 1], ['active', 'login_attempt', now + 1],
    ['invite', 'account_link', now], ['oauth', 'identity', now - 1],
    ['canvas', 'canvas', now - 1], ['mfa', 'chair_mfa_pending', now - 1],
  ]) await db.prepare('INSERT INTO transactions(id,kind,data,expires) VALUES (?,?,?,?)').run(id, kind, '{}', expires);
  for (let index = 0; index < 1100; index++) {
    await db.prepare('INSERT INTO transactions(id,kind,data,expires) VALUES (?,?,?,?)').run('attempt-' + index, 'reset_attempt', '{}', now - 1);
    await db.prepare('INSERT INTO sessions(id,workspace,member_id,csrf,expires) VALUES (?,?,?,?,?)').run('session-' + index, 'chapter', 'test', 'csrf', now);
  }
  await db.prepare('INSERT INTO sessions(id,workspace,member_id,csrf,expires) VALUES (?,?,?,?,?)').run('active', 'chapter', 'test', 'csrf', now + 1);
  await cleanupExpiredAuth(db, now);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM transactions').get()).count, 108);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).count, 101);
  await cleanupExpiredAuth(db, now);
  assert.deepEqual((await db.prepare('SELECT id FROM transactions ORDER BY id').all()).map(row => row.id), ['active', 'mutation', 'recovery', 'unknown']);
  assert.deepEqual((await db.prepare('SELECT id FROM sessions').all()).map(row => row.id), ['active']);
});
