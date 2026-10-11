import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {generateRecoveryKey, normalizeRecoveryKey, issueSemesterRecoveryKey, recoveryKeyStatus,
  confirmRecoveryKey, beginRecovery, cancelRecovery, finishRecovery, clearRecoveryKey} from '../server/recovery.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ato-recovery-'));
  const db = await openDatabase({env:{}, directory});
  const args = ['chapter', 'test-member', 'initial'];
  const txn = fn => db.transaction(fn);
  try {
    await db.prepare('INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES (?,?,?,?,?,?,?,1)')
      .run('chapter','test-member','Fictional Member','fiction@example.test','member',1,15);
    await run(db,args,txn);
  } finally { await db.close(); await rm(directory,{recursive:true,force:true}); }
}

test('recovery key acknowledgement is idempotent; a lost unconfirmed response can be replaced without persisting the words', () => fixture(async (db,args,txn) => {
  const first = await txn(() => issueSemesterRecoveryKey(db,...args));
  assert.equal(first.split(' ').length,16);
  assert.equal(normalizeRecoveryKey(first.toUpperCase().replaceAll(' ','\n')),first);
  assert.equal(normalizeRecoveryKey(first+' extra'),null);
  assert.equal((await recoveryKeyStatus(db,...args)).needsKey,true);
  assert.equal(await txn(() => beginRecovery(db,...args,first)),null,'unconfirmed words cannot reset a password');
  const second = await txn(() => issueSemesterRecoveryKey(db,...args));
  assert.notEqual(first,second);
  await assert.rejects(txn(() => confirmRecoveryKey(db,...args,first)),/replaced/);
  await txn(() => confirmRecoveryKey(db,...args,second));
  await txn(() => confirmRecoveryKey(db,...args,second));
  assert.equal((await recoveryKeyStatus(db,...args)).needsKey,false);
  assert.equal(await txn(() => issueSemesterRecoveryKey(db,...args)),null);
  const stored = (await db.prepare("SELECT data FROM transactions WHERE kind='recovery_key'").get()).data;
  assert.equal(stored.includes(first),false); assert.equal(stored.includes(second),false);
  assert.match(JSON.parse(stored).hash,/^[a-f0-9]{64}$/);
  assert.match(JSON.parse(stored).salt,/^[a-f0-9]{32}$/);
}));

test('consuming a key revokes sessions and never restores it after a failed or ambiguous provider response', () => fixture(async (db,args,txn) => {
  const first = await txn(() => issueSemesterRecoveryKey(db,...args));
  await txn(() => confirmRecoveryKey(db,...args,first));
  await db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('old','chapter','test-member','csrf',Date.now()+100000);
  assert.equal(await txn(() => beginRecovery(db,...args,generateRecoveryKey())),null);
  assert.ok(await db.prepare("SELECT id FROM sessions WHERE id='old'").get());
  const reservation = await txn(() => beginRecovery(db,...args,first));
  assert.match(reservation,/^[a-f0-9]{64}$/);
  assert.equal(await db.prepare("SELECT id FROM sessions WHERE id='old'").get(),undefined);
  assert.equal(await txn(() => beginRecovery(db,...args,first)),null);
  await assert.rejects(txn(() => issueSemesterRecoveryKey(db,...args)),/in progress/);
  await txn(() => cancelRecovery(db,args[0],args[1],reservation));
  assert.equal(await txn(() => beginRecovery(db,...args,first)),null,'failure cannot reactivate the consumed key');
  assert.equal((await recoveryKeyStatus(db,...args)).needsKey,true);
  const afterLogin = await txn(() => issueSemesterRecoveryKey(db,...args));
  assert.notEqual(afterLogin,first);
  await txn(() => confirmRecoveryKey(db,...args,afterLogin));
  const next = await txn(() => beginRecovery(db,...args,afterLogin));
  await assert.rejects(txn(async () => { await finishRecovery(db,...args,next); throw Error('simulated final commit failure'); }),/simulated/);
  assert.equal(await txn(() => beginRecovery(db,...args,afterLogin)),null,'a failed final commit cannot undo the earlier consumed key');
  await txn(() => finishRecovery(db,...args,next));
  assert.equal((await recoveryKeyStatus(db,...args)).needsKey,true);
}));

test('expired recovery reservation cannot reuse old words; semester changes invalidate prior keys', () => fixture(async (db,args,txn) => {
  const first = await txn(() => issueSemesterRecoveryKey(db,...args));
  await txn(() => confirmRecoveryKey(db,...args,first));
  await txn(() => beginRecovery(db,...args,first));
  const row = await db.prepare("SELECT id,data FROM transactions WHERE kind='recovery_key'").get();
  const state = {...JSON.parse(row.data),pendingUntil:Date.now()-1};
  await db.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify(state),row.id);
  assert.equal(await txn(() => beginRecovery(db,...args,first)),null);
  const next = await txn(() => issueSemesterRecoveryKey(db,'chapter','test-member','next'));
  await txn(() => confirmRecoveryKey(db,'chapter','test-member','next',next));
  assert.equal(await txn(() => beginRecovery(db,...args,next)),null);
  assert.equal(await txn(() => beginRecovery(db,'chapter','test-member','next',first)),null);
  await txn(() => clearRecoveryKey(db,'chapter','test-member'));
  assert.equal(await db.prepare("SELECT data FROM transactions WHERE kind='recovery_key'").get(),undefined);
}));
