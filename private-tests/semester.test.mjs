import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/database.mjs';
import { checkpointQuotaView } from '../web/checkpoint-data.mjs';
import {
  SemesterError, UPLOAD_GRANT_DRAIN_MS, validateSemesterSettings, assertAcademicWritesAllowed,
  semesterResetStatus, previewSemesterReset, startSemesterReset, resumeSemesterReset,
} from '../server/semester.mjs';

const epoch = Date.parse('2026-12-20T12:00:00.000Z');
const nextSemester = { name: 'Spring 2027', startDate: '2027-01-10', checkpointDates: ['2027-02-01', '2027-03-01', '2027-04-01'],
  targetDate: '2027-05-01', endDate: '2027-05-08' };
const importMapping = { headerRow: 1, firstDataRow: 2, nameMode: 'full',
  columns: { first: -1, last: -1, full: 0, gpa: 1, schoolId: -1, email: -1 } };
const local = { id: '0a608529-4d42-4332-a996-fca00a3ce2e0', backend: 'local',
  filename: '0a608529-4d42-4332-a996-fca00a3ce2e0.bin', final_path: null, status: 'ready' };
const hosted = { id: '01bbbc31-b15a-4e7d-a28f-313ac9b76c2e', backend: 'supabase',
  filename: 'quarantine/chapter/member/01bbbc31-b15a-4e7d-a28f-313ac9b76c2e',
  final_path: 'evidence/chapter/member/95a761f6-9c47-42d3-bdf6-32a231dfde8a', status: 'ready' };

async function fixture(t, files = [local]) {
  const directory = await mkdtemp(join(tmpdir(), 'ato-semester-test-'));
  const f = { directory, db: await openDatabase({ directory, env: {} }), time: epoch };
  f.now = () => f.time;
  t.after(async () => { await f.db.close(); await rm(directory, { recursive: true, force: true }); });
  f.state = async () => JSON.parse((await f.db.prepare('SELECT data FROM chapters WHERE workspace=?').get('chapter')).data);
  await f.db.prepare('UPDATE chapters SET data=? WHERE workspace=?').run(JSON.stringify({
    submissions: [{ id: 'S-sensitive', owner: 'member', grade: 97, reviewNote: 'private academic comment' }],
    semester: { name: 'Fall 2026' }, semesterGeneration: 'old-generation',
    profilePictures: { alex: 'test-upload' },
    creditRequests: [{ id: 'test-request', owner: 'alex', credits: 12, status: 'pending' }],
    memberProfiles: { alex: { courses: ['MTH 2002'], version: 'test' } },
    checkpointQuotas: [[1, 2, 3, 4, 5], [2, 4, 6, 8, 10], [3, 6, 9, 12, 15], [4, 8, 12, 16, 20]], checkpointQuotaRevision: 2,
    tierAssignments: { 'future@example.edu': 4 }, gpaImportMapping: importMapping,
    faqEntries: [{ id: 'shared-question', question: 'Test question?', answer: 'Shared answer.' }], faqRevision: 'test-revision',
  }), 'chapter');
  await f.db.prepare('INSERT INTO members(workspace,id,name,email,role,tier,credits) VALUES (?,?,?,?,?,?,?)').run(
    'chapter', 'member', 'Retained Member', 'member@example.edu', 'member', 2, 15,
  );
  await f.db.prepare('INSERT INTO identities(workspace,provider,subject,member_id) VALUES (?,?,?,?)').run(
    'chapter', 'google', 'retained-stable-subject', 'member',
  );
  for (const file of files) {
    await f.db.prepare('INSERT INTO uploads(id,workspace,owner,name,mime,size,filename,created_at,status,backend,final_path) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      file.id, 'chapter', 'member', 'private-grade.pdf', 'application/pdf', 100, file.filename,
      file.created_at ?? new Date(epoch).toISOString(), file.status, file.backend, file.final_path,
    );
  }
  for (const [action, detail] of [['submission.approved', 'private academic comment'], ['roster.invite', 'retained identity event']]) {
    await f.db.prepare('INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)').run(
      'chapter', new Date(epoch).toISOString(), 'Chair', action, 'member', detail,
    );
  }
  f.start = async (changed = {}) => {
    const previewToken = 'previewToken' in changed ? changed.previewToken :
      (await previewSemesterReset({ db: f.db, workspace: 'chapter', now: f.now })).previewToken;
    return startSemesterReset({ db: f.db, workspace: 'chapter', actor: 'Chair',
      confirm: 'DELETE SEMESTER', semester: nextSemester, now: f.now, previewToken, ...changed });
  };
  f.resume = (deleteObject, changed = {}) => resumeSemesterReset({ db: f.db, workspace: 'chapter',
    deleteObject, now: f.now, ...changed });
  return f;
}

test('semester calendar requires explicit ordered dates and does not invent checkpoints or alter tier targets', () => {
  assert.deepEqual(validateSemesterSettings(nextSemester), nextSemester);
  for (const invalid of [
    { ...nextSemester, name: '' }, { ...nextSemester, checkpointDates: [] },
    { ...nextSemester, checkpointDates: ['2027-02-30', '2027-03-01', '2027-04-01'] },
    { ...nextSemester, checkpointDates: ['2027-03-01', '2027-02-01', '2027-04-01'] },
    { ...nextSemester, startDate: '2027-02-01' }, { ...nextSemester, targetDate: '2027-04-01' },
    { ...nextSemester, endDate: '2027-04-30' }, { ...nextSemester, name: 'Spring\n2027' },
  ]) assert.throws(() => validateSemesterSettings(invalid), SemesterError);
  assert.deepEqual(validateSemesterSettings({ ...nextSemester, tierTargets: [0, 0, 0, 0, 0] }), nextSemester);
});

test('preview does not change academic records and exposes counts without academic content or object paths', async t => {
  const f = await fixture(t);
  const before = await f.state();
  const preview = await previewSemesterReset({ db: f.db, workspace: 'chapter', now: f.now });
  assert.deepEqual(preview.counts, { submissions: 1, evidence: 1, accounts: 1, objects: 1 });
  assert.equal(preview.confirmation, 'DELETE SEMESTER');
  assert.match(preview.backupNotice, /backups/);
  assert.ok(!JSON.stringify(preview).includes('private academic comment'));
  assert.ok(!JSON.stringify(preview).includes(local.filename));
  const after = await f.state();
  assert.ok(preview.previewToken);
  assert.equal(after.semesterPreview.token, preview.previewToken);
  delete after.semesterPreview;
  assert.deepEqual(after, before);
});

test('incorrect confirmation and incomplete semester settings cannot erase any data', async t => {
  const f = await fixture(t);
  for (const changed of [{ confirm: 'delete semester' }, { confirm: true }, { semester: { name: 'Next term' } }]) {
    await assert.rejects(f.start(changed), error => error instanceof SemesterError && error.status === 422);
  }
  assert.equal((await f.state()).submissions.length, 1);
  assert.equal((await f.db.prepare('SELECT id FROM uploads').all()).length, 1);
});

test('start atomically removes academic access, preserves accounts/security audit, and persists the deletion inventory', async t => {
  const f = await fixture(t);
  const status = await f.start();
  const state = await f.state();
  assert.equal(status.status, 'purging');
  assert.equal(status.remaining, 1);
  assert.deepEqual(state.submissions, []);
  assert.equal(state.tierAssignments, undefined, 'old-semester staged tiers are cleared');
  assert.equal(state.memberProfiles, undefined, 'old-semester classes are cleared');
  assert.equal(state.creditRequests, undefined, 'old-semester credit evidence requests are cleared');
  assert.equal(state.profilePictures, undefined, 'profile image references clear with semester uploads');
  assert.equal(state.checkpointQuotas, undefined, 'new semesters start with default quotas');
  assert.equal(state.checkpointQuotaRevision, undefined);
  assert.notEqual(checkpointQuotaView(state).version, 'old-generation:2', 'old quota forms cannot overwrite the new semester');
  assert.deepEqual(state.gpaImportMapping, importMapping, 'column layout remains available');
  assert.equal(state.faqEntries[0].answer, 'Shared answer.', 'shared FAQ survives semester resets');
  assert.equal(state.faqRevision, 'test-revision');
  assert.notEqual(state.semesterGeneration, 'old-generation');
  assert.equal(state.semester.name, 'Fall 2026', 'next term must not activate before storage deletion');
  assert.equal(state.semesterReset.objects[0].path, local.filename);
  assert.equal((await f.db.prepare('SELECT id FROM uploads').all()).length, 0);
  assert.equal((await f.db.prepare('SELECT id FROM members').all()).length, 1);
  assert.equal((await f.db.prepare('SELECT subject FROM identities').all())[0].subject, 'retained-stable-subject');
  const audit = await f.db.prepare('SELECT action,detail FROM audit').all();
  assert.ok(audit.some(item => item.action === 'roster.invite'));
  assert.ok(audit.some(item => item.action === 'semester.reset.start'));
  assert.ok(!JSON.stringify(audit).includes('private academic comment'));
  assert.throws(() => assertAcademicWritesAllowed(state), error => error.status === 423);
  assert.ok(!JSON.stringify(status).includes(local.filename));
  await assert.rejects(f.start(), error => error.status === 423);
});

test('both quarantine and final references remain planned for recently finalized and pending uploads', async t => {
  const pending = { ...hosted, id: '828f6d5d-f879-4675-a66e-04e2e6e1a6c3', status: 'pending',
    filename: 'quarantine/chapter/member/828f6d5d-f879-4675-a66e-04e2e6e1a6c3',
    final_path: 'evidence/chapter/member/a2a5b7cd-1066-45fb-969e-ecf356f463bb' };
  const f = await fixture(t, [hosted, pending]);
  const status = await f.start();
  assert.equal(status.count, 4);
  const objects = (await f.state()).semesterReset.objects;
  for (const object of objects) {
    assert.equal(object.notBefore, object.path.startsWith('quarantine/') ? epoch + UPLOAD_GRANT_DRAIN_MS : epoch + 300_000);
  }
  assert.equal((await f.db.prepare('SELECT id FROM uploads').all()).length, 0);
});

test('provider failure leaves resumable durable progress; restart and successful retry activate the next semester', async t => {
  const f = await fixture(t);
  await f.start();
  const failed = await f.resume(async () => { throw Error('secret-provider-key-and-path'); });
  assert.equal(failed.status, 'purging');
  assert.equal(failed.remaining, 1);
  assert.ok(failed.lastError);
  assert.ok(!JSON.stringify(failed).includes('secret-provider'));
  const generation = (await f.state()).semesterGeneration;
  await f.db.close();
  f.db = await openDatabase({ directory: f.directory, env: {} });
  assert.equal((await f.state()).semesterReset.objects[0].path, local.filename);
  f.time += 30_001;
  let deleted;
  const finished = await f.resume(async object => { deleted = object; return { deleted: true }; });
  assert.deepEqual(deleted, { backend: 'local', path: local.filename });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.remaining, 0);
  assert.equal(finished.deleted, 1);
  const state = await f.state();
  assert.deepEqual(state.semester, nextSemester);
  assert.equal(state.semesterGeneration, generation);
  assert.deepEqual(state.semesterReset.objects, [], 'completed jobs discard former evidence paths');
  assert.doesNotThrow(() => assertAcademicWritesAllowed(state));
  assert.equal((await f.db.prepare('SELECT id FROM members').all()).length, 1);
  assert.equal((await f.resume(() => assert.fail('completed reset must not delete again'))).status, 'completed');
});

test('a delete response alone is insufficient: only explicit verified absence advances the job', async t => {
  const f = await fixture(t);
  await f.start();
  for (const result of [undefined, {}, { deleted: false }, { deleted: 'true' }]) {
    const status = await f.resume(async () => result);
    assert.equal(status.status, 'purging');
    assert.equal(status.remaining, 1);
    f.time += 30_001;
  }
  assert.equal((await f.resume(async () => ({ deleted: true }))).status, 'completed');
});

test('recent upload grants delay final completion until quarantine cannot be recreated', async t => {
  const f = await fixture(t, [hosted]);
  await f.start();
  const deleted = [];
  const remove = async object => { deleted.push(object.path); return { deleted: true }; };
  assert.equal((await f.resume(remove)).phase, 'waiting');
  assert.equal(deleted.length, 0, 'in-flight finalizers must drain before final evidence deletion');
  f.time += 300_000;
  const first = await f.resume(remove);
  assert.equal(first.status, 'purging');
  assert.equal(first.phase, 'waiting');
  assert.equal(first.remaining, 1);
  assert.deepEqual(deleted, [hosted.final_path]);
  assert.equal(first.nextAttemptAt, new Date(epoch + UPLOAD_GRANT_DRAIN_MS).toISOString());
  f.time = epoch + UPLOAD_GRANT_DRAIN_MS - 1;
  assert.equal((await f.resume(remove)).phase, 'waiting');
  assert.equal(deleted.length, 1);
  f.time += 1;
  assert.equal((await f.resume(remove)).status, 'completed');
  assert.deepEqual(deleted, [hosted.final_path, hosted.filename]);
});

test('concurrent resume requests cannot duplicate active work while its durable lease is valid', async t => {
  const f = await fixture(t);
  await f.start();
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { finish = resolve; });
  const first = f.resume(async () => { entered(); await blocked; return { deleted: true }; });
  await started;
  const second = await f.resume(() => assert.fail('a second worker must not process an active lease'));
  assert.equal(second.phase, 'working');
  finish();
  assert.equal((await first).status, 'completed');
});

test('failure after physical deletion but before database commit is recoverable after lease expiry', async t => {
  const f = await fixture(t);
  await f.start();
  let checks = 0;
  let existing = true;
  await assert.rejects(f.resume(async () => { existing = false; return { deleted: true }; }, {
    authorize: async () => { if (++checks === 2) throw Error('simulated interrupted commit'); },
  }), /interrupted commit/);
  assert.equal(existing, false);
  let state = await f.state();
  assert.equal(state.semesterReset.status, 'purging');
  assert.equal(state.semesterReset.objects[0].deletedAt, null);
  f.time += 120_001;
  const recovered = await f.resume(async () => ({ deleted: !existing }));
  assert.equal(recovered.status, 'completed');
  state = await f.state();
  assert.equal(state.semester.name, nextSemester.name);
});

test('authorization is rechecked under lock before reset and before resume can touch storage', async t => {
  const f = await fixture(t);
  const denied = async () => { throw Error('inactive chair'); };
  await assert.rejects(f.start({ authorize: denied }), /inactive chair/);
  assert.equal((await f.state()).submissions.length, 1);
  await f.start();
  await assert.rejects(f.resume(() => assert.fail('unauthorized worker must not delete evidence'), { authorize: denied }), /inactive chair/);
  assert.equal((await f.state()).semesterReset.objects[0].deletedAt, null);
});

test('empty semesters finish atomically; later resets issue a fresh generation and preserve accounts', async t => {
  const f = await fixture(t, []);
  const first = await f.start();
  assert.equal(first.status, 'completed');
  const generation = (await f.state()).semesterGeneration;
  const second = await f.start({ semester: { ...nextSemester, name: 'Replacement term' } });
  assert.equal(second.status, 'completed');
  assert.notEqual((await f.state()).semesterGeneration, generation);
  assert.equal((await f.db.prepare('SELECT id FROM members').all()).length, 1);
  assert.equal(semesterResetStatus({ submissions: [] }).status, 'idle');
});

test('invalid storage references abort before academic records or object inventory are discarded', async t => {
  const f = await fixture(t, [{ ...local, filename: '../../important-file' }]);
  await assert.rejects(f.start(), error => error instanceof SemesterError && error.code === 'SEMESTER_STORAGE');
  assert.equal((await f.state()).submissions.length, 1);
  assert.equal((await f.db.prepare('SELECT id FROM uploads').all()).length, 1);
});

test('expired, forged and stale preview tokens cannot authorize deletion of newly arrived work', async t => {
  const f = await fixture(t);
  const preview = await previewSemesterReset({ db: f.db, workspace: 'chapter', now: f.now });
  for (const previewToken of [undefined, 'wrong-token', 'ä'.repeat(36)]) {
    await assert.rejects(f.start({ previewToken }), error => error.code === 'SEMESTER_PREVIEW_STALE');
  }
  const state = await f.state();
  state.submissions.push({ id: 'arrived-after-preview', grade: 100 });
  await f.db.prepare('UPDATE chapters SET data=? WHERE workspace=?').run(JSON.stringify(state), 'chapter');
  await assert.rejects(f.start({ previewToken: preview.previewToken }), error => error.code === 'SEMESTER_PREVIEW_STALE');
  assert.equal((await f.state()).submissions.length, 2);
  const fresh = await previewSemesterReset({ db: f.db, workspace: 'chapter', now: f.now });
  assert.equal(fresh.counts.submissions, 2);
  f.time += 600_001;
  await assert.rejects(f.start({ previewToken: fresh.previewToken }), error => error.code === 'SEMESTER_PREVIEW_STALE');
  assert.equal((await f.state()).submissions.length, 2);
  assert.equal((await f.start()).status, 'purging');
});
