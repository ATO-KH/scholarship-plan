// Fictional-only rehearsal: no environment credentials, network, or existing data paths.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../server/database.mjs';
import { openTokens, sealTokens } from '../server/canvas.mjs';
import { deleteStoredEvidenceAndVerify } from '../server/storage.mjs';
import { assertAcademicWritesAllowed, previewSemesterReset, startSemesterReset, resumeSemesterReset, UPLOAD_GRANT_DRAIN_MS } from '../server/semester.mjs';

const epoch = Date.parse('2026-12-20T12:00:00Z');
const nextSemester = { name: 'Fictional Spring', startDate: '2027-01-10', checkpointDates: ['2027-02-01', '2027-03-01', '2027-04-01'], targetDate: '2027-05-01', endDate: '2027-05-08' };
const paths = [
  'evidence/70a62e68-5ec5-4c3d-9ae5-87fb1cb50f8e.bin',
  'objects/quarantine/chapter/member/50bcd8a2-059b-4a74-a11a-91e2abf1d2a7',
  'objects/evidence/chapter/member/665fdaee-8ca4-4d46-8a51-d277cddcb384',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const write = async (file, bytes) => { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600 }); };

// The caller has closed the lab database and stopped writes before taking a copy.
async function takeSnapshot(source, destination) {
  const manifest = { fictional: true, files: [] };
  for (const path of ['chapter.sqlite', ...paths]) {
    const bytes = await readFile(join(source, path));
    await write(join(destination, path), bytes);
    manifest.files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  await write(join(destination, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

async function restoreSnapshot(source, destination) {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  assert.equal(manifest.fictional, true);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), ['chapter.sqlite', ...paths].sort());
  // Verify all bytes first: a missing/corrupt file must not create a partial restore.
  const verified = await Promise.all(manifest.files.map(async file => {
    const bytes = await readFile(join(source, file.path));
    assert.equal(bytes.length, file.bytes, 'Backup file length changed');
    assert.equal(digest(bytes), file.sha256, 'Backup checksum mismatch');
    return { path: file.path, bytes };
  }));
  for (const file of verified) await write(join(destination, file.path), file.bytes);
  return manifest;
}

export async function runOperationsRehearsal({ fault = null } = {}) {
  if (![null, 'missing-object', 'corrupt-object', 'unexpected-path'].includes(fault)) throw Error('Unknown fictional rehearsal fault.');
  const root = await mkdtemp(join(tmpdir(), 'ato-fictional-operations-'));
  const live = join(root, 'original'), backup = join(root, 'backup'), restored = join(root, 'restored');
  const key = { APP_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  const tokens = { accessToken: 'fictional-access-token', refreshToken: 'fictional-refresh-token', expiresAt: epoch + 60_000 };
  const checks = [];
  let db;
  try {
    db = await openDatabase({ directory: live, env: {} });
    await db.prepare('UPDATE chapters SET data=? WHERE workspace=?').run(JSON.stringify({
      semester: { name: 'Fictional Fall' }, semesterGeneration: 'fictional-old-semester',
      submissions: [{ id: 'fictional-assignment', owner: 'member', grade: 95, status: 'approved', points: 10 }],
      syllabi: [{ id: 'fictional-syllabus', owner: 'member', status: 'approved' }],
      classRecords: [{ id: 'fictional-class', owner: 'member', syllabusId: 'fictional-syllabus' }],
      creditRequests: [{ owner: 'member', credits: 15 }], profilePictures: { member: 'fictional-image' },
      pointAdjustments: [{ owner: 'member', delta: 5 }], tierAssignments: { 'fictional@example.invalid': 2 },
      faqEntries: [{ id: 'help', question: 'How do I submit?', answer: 'Use New submission.' }],
    }), 'chapter');
    await db.prepare('INSERT INTO members(workspace,id,name,email,role,tier,credits) VALUES (?,?,?,?,?,?,?)').run('chapter', 'member', 'Fictional Member', 'fictional@example.invalid', 'member', 2, 15);
    await db.prepare('INSERT INTO identities(workspace,provider,subject,member_id) VALUES (?,?,?,?)').run('chapter', 'chapter', 'fictional-subject', 'member');
    await db.prepare('INSERT INTO integrations(workspace,member_id,data,revision) VALUES (?,?,?,?)').run('chapter', 'member', sealTokens(tokens, key), 'fictional-revision');
    for (const action of ['submission.approved', 'syllabus.approved', 'roster.invite']) {
      await db.prepare('INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)').run('chapter', new Date(epoch).toISOString(), 'Fictional Chair', action, 'member', 'Fictional fixture');
    }
    const bytes = Buffer.from('%PDF-1.7\nFictional evidence bytes: no real student information.\n%%EOF');
    for (const path of paths) await write(join(live, path), bytes);
    const local = { id: '70a62e68-5ec5-4c3d-9ae5-87fb1cb50f8e', filename: paths[0].slice('evidence/'.length), backend: 'local', final: null };
    const hosted = { id: '50bcd8a2-059b-4a74-a11a-91e2abf1d2a7', filename: paths[1].slice('objects/'.length), backend: 'supabase', final: paths[2].slice('objects/'.length) };
    for (const row of [local, hosted]) {
      await db.prepare('INSERT INTO uploads(id,workspace,owner,name,mime,size,filename,created_at,status,backend,final_path) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id, 'chapter', 'member', 'fictional.pdf', 'application/pdf', bytes.length, row.filename, new Date(epoch).toISOString(), 'ready', row.backend, row.final);
    }
    await db.close(); db = null;
    const manifest = await takeSnapshot(live, backup);
    assert.equal(manifest.files.length, 4);
    assert.equal(manifest.files.filter(file => file.path !== 'chapter.sqlite').length, 3);
    checks.push('Database and all three actual evidence objects backed up with hashes');
    if (fault === 'missing-object') await rm(join(backup, paths[1]));
    if (fault === 'corrupt-object') await writeFile(join(backup, paths[1]), Buffer.alloc(bytes.length));
    if (fault === 'unexpected-path') {
      manifest.files[1].path = '../outside';
      await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest));
    }
    if (fault) {
      await assert.rejects(restoreSnapshot(backup, restored));
      assert.equal(await exists(restored), false);
      return { fictionalOnly: true, checks: [`Incomplete or altered backup rejected before restoration: ${fault}`], cleanedUp: true };
    }

    const state = async () => JSON.parse((await db.prepare('SELECT data FROM chapters WHERE workspace=?').get('chapter')).data);
    let clock = epoch;
    let databaseDirectory = live;
    const start = async () => {
      const preview = await previewSemesterReset({ db, workspace: 'chapter', now: () => clock });
      return startSemesterReset({ db, workspace: 'chapter', actor: 'Fictional Chair', confirm: 'DELETE SEMESTER', semester: nextSemester, previewToken: preview.previewToken, now: () => clock });
    };
    const removeObject = async object => {
      if (object.backend === 'local') {
        const path = join(databaseDirectory, 'evidence', object.path);
        await rm(path, { force: true });
        return { deleted: !(await exists(path)) };
      }
      // Use the production deletion client with a strictly local Storage transport.
      return deleteStoredEvidenceAndVerify({ path: object.path,
        env: { SUPABASE_URL: 'https://fictional.supabase.co', SUPABASE_STORAGE_BUCKET: 'fictional-evidence', SUPABASE_SECRET_KEY: 'sb_secret_fictional_rehearsal_only' },
        fetchImpl: async (url, request) => {
          const route = new URL(url).pathname;
          if (request.method === 'DELETE' && route === '/storage/v1/object/fictional-evidence') {
            const { prefixes } = JSON.parse(request.body);
            assert.deepEqual(prefixes, [object.path]);
            await rm(join(databaseDirectory, 'objects', object.path), { force: true });
            return new Response('{}', { status: 200 });
          }
          assert.equal(request.method, 'HEAD');
          assert.equal(route, `/storage/v1/object/fictional-evidence/${object.path}`);
          return new Response(null, { status: await exists(join(databaseDirectory, 'objects', object.path)) ? 200 : 404 });
        },
      });
    };
    const resume = authorize => resumeSemesterReset({ db, workspace: 'chapter', deleteObject: removeObject, now: () => clock, ...(authorize ? { authorize } : {}) });
    const verifyCleared = async () => {
      const current = await state();
      assert.deepEqual(current.submissions, []);
      for (const field of ['syllabi', 'classRecords', 'creditRequests', 'profilePictures', 'pointAdjustments', 'tierAssignments']) assert.equal(current[field], undefined);
      assert.equal(current.semesterReset.status, 'completed');
      assert.deepEqual(current.semesterReset.objects, []);
      assert.equal(current.semester.name, nextSemester.name);
      assert.equal((await db.prepare('SELECT id FROM uploads').all()).length, 0);
      assert.equal((await db.prepare('SELECT id FROM members').all()).length, 1);
      assert.equal((await db.prepare('SELECT subject FROM identities').all())[0].subject, 'fictional-subject');
      assert.equal(current.faqEntries.length, 1);
      for (const path of paths) assert.equal(await exists(join(databaseDirectory, path)), false);
      const events = (await db.prepare('SELECT action FROM audit').all()).map(event => event.action);
      assert.ok(events.includes('roster.invite'));
      assert.ok(!events.includes('submission.approved') && !events.includes('syllabus.approved'));
    };
    db = await openDatabase({ directory: live, env: {} });
    await start();
    const purgingState = await state();
    assert.throws(() => assertAcademicWritesAllowed(purgingState), error => error.status === 423);
    let authorizationChecks = 0;
    await assert.rejects(resume(async () => { if (++authorizationChecks === 2) throw Error('Fictional crash after object deletion'); }), /Fictional crash/);
    assert.equal(await exists(join(live, paths[0])), false);
    assert.equal((await state()).semesterReset.status, 'purging');
    await db.close();
    db = await openDatabase({ directory: live, env: {} });
    clock += 120_001;
    await resume();
    clock = epoch + 300_000;
    const held = await resume();
    assert.equal(held.status, 'purging');
    assert.equal(held.remaining, 1);
    assert.equal(await exists(join(live, paths[1])), true, 'Quarantine must survive until upload grants expire');
    clock = epoch + UPLOAD_GRANT_DRAIN_MS;
    assert.equal((await resume()).status, 'completed');
    await verifyCleared();
    checks.push('Interrupted deletion resumed after restart; quarantine wait honored; all evidence absent');
    checks.push('Accounts, identity bindings and FAQ retained; academic records and academic audit removed');
    await db.close(); db = null;

    await restoreSnapshot(backup, restored);
    databaseDirectory = restored;
    db = await openDatabase({ directory: restored, env: {} });
    assert.equal((await state()).submissions.length, 1, 'An old backup still contains old academic data');
    for (const path of paths) assert.deepEqual(await readFile(join(restored, path)), bytes);
    const sealed = (await db.prepare('SELECT data FROM integrations').get()).data;
    assert.deepEqual(openTokens(sealed, key), tokens);
    assert.throws(() => openTokens(sealed, { APP_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
    checks.push('Restored database and file bytes match; matching encryption key works and a replacement fails');
    // The restored environment is not served. Reapply the completed wipe before access.
    await start();
    await resume();
    clock += UPLOAD_GRANT_DRAIN_MS;
    while ((await state()).semesterReset.status !== 'completed') await resume();
    await verifyCleared();
    checks.push('A pre-wipe restore stayed offline until the intended wipe was reapplied');
    await db.close(); db = null;
    await rm(backup, { recursive: true });
    assert.equal(await exists(backup), false);
    checks.push('Independent backup removed separately from live semester cleanup');
    return { fictionalOnly: true, checks, cleanedUp: true, limitations: ['Local SQLite and a filesystem-backed Storage mock; no live Supabase, PostgreSQL, Vercel or email checks'] };
  } finally {
    if (db) await db.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) throw Error('This rehearsal takes no arguments and never opens existing data.');
  const result = await runOperationsRehearsal();
  for (const check of result.checks) console.log(`PASS: ${check}`);
  console.log('Fictional temporary data removed. No real service was contacted.');
  console.log(result.limitations.join('\n'));
}
