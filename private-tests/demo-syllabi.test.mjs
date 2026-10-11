import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../web/demo/demo-service.mjs';

const pdf = '%PDF-1.4\n% Fictional syllabus for sandbox verification\n%%EOF\n';
const file = { name: 'syllabus.pdf', mime: 'application/pdf', size: Buffer.byteLength(pdf), dataUrl: `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}` };
const assignment = { activity: 'major', title: 'Syllabus workflow exam', course: 'MTH 2002', date: '2026-09-28', grade: 95, evidence: 'sample', confirm: true };

async function withSandbox(run) {
  const originalStorage = globalThis.sessionStorage;
  const store = new Map();
  globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const call = async (path, body) => {
    const response = await handle(new Request(`https://demo.test/demo${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), path);
    return { status: response.status, ...await response.json() };
  };
  try { await run(call, store); } finally { globalThis.sessionStorage = originalStorage; }
}

test('sandbox classes require verified syllabus files and are private to their member', () => withSandbox(async call => {
  await call('/api/demo/session', { persona: 'test1' });
  assert.equal((await call('/api/classes', { name: 'MTH 2002' })).status, 422);
  assert.equal((await call('/api/classes', { name: 'MTH 2002', file: { ...file, mime: 'text/html' } })).status, 422);
  assert.equal((await call('/api/classes', { name: 'MTH 2002', file: { ...file, size: file.size + 1 } })).status, 422);
  assert.equal((await call('/api/classes', { name: 'MTH 2002', file: { ...file, dataUrl: `data:application/pdf;base64,${Buffer.from('not PDF').toString('base64')}`, size: 7 } })).status, 422);
  const created = await call('/api/classes', { name: ' MTH 2002 ', file });
  assert.equal(created.status, 201);
  assert.equal(created.class.name, 'MTH 2002');
  assert.equal(created.class.status, 'pending');
  assert.equal((await call('/api/classes')).classes.length, 1);
  assert.ok(!(JSON.stringify(created).includes(file.dataUrl)), 'Class summaries must omit file contents.');
  const evidence = await call(`/api/syllabi/${created.class.syllabusId}/evidence`);
  assert.equal(evidence.previewUrl, file.dataUrl);
  assert.equal(evidence.mime, file.mime);
  assert.equal((await call('/api/syllabi')).status, 403);
  assert.equal((await call(`/api/syllabi/${created.class.syllabusId}/review`, { decision: 'approved', note: '', version: created.class.version })).status, 403);
  await call('/api/demo/session', { persona: 'jordan' });
  assert.deepEqual((await call('/api/classes')).classes, []);
  assert.equal((await call(`/api/syllabi/${created.class.syllabusId}/evidence`)).status, 404);
  assert.equal((await call(`/api/classes/${created.class.id}/archive`, { version: created.class.version })).status, 404);
  await call('/api/demo/session', { persona: 'chair' });
  assert.equal((await call('/api/classes', { name: 'Chair class', file })).status, 403);
  const queue = await call('/api/syllabi');
  assert.equal(queue.status, 200);
  assert.equal(queue.syllabi.length, 1);
  assert.ok(!JSON.stringify(queue).includes(file.dataUrl));
  assert.equal((await call(`/api/syllabi/${created.class.syllabusId}/evidence`)).status, 200);
}));

test('sandbox approval gates grade assignments and preserves the submitted syllabus version', () => withSandbox(async call => {
  await call('/api/demo/session', { persona: 'test1' });
  assert.equal((await call('/api/submissions', assignment)).status, 422);
  const created = await call('/api/classes', { name: assignment.course, file });
  assert.equal(created.status, 201);
  const id = created.class.id;
  const syllabusId = created.class.syllabusId;
  for (const activity of ['major', 'minor', 'lab']) {
    assert.equal((await call('/api/submissions', { ...assignment, activity, classId: id })).status, 422);
  }
  await call('/api/demo/session', { persona: 'chair' });
  const queued = (await call('/api/syllabi')).syllabi.find(item => item.id === syllabusId);
  const reviewed = await call(`/api/syllabi/${syllabusId}/review`, { decision: 'approved', note: '', version: queued.version });
  assert.equal(reviewed.status, 200);
  assert.equal((await call(`/api/syllabi/${syllabusId}/review`, { decision: 'approved', note: '', version: queued.version })).status, 409);
  await call('/api/demo/session', { persona: 'test1' });
  const submitted = await call('/api/submissions', { ...assignment, course: 'Forged course text', classId: id });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.submission.course, assignment.course);
  assert.equal(submitted.submission.classId, id);
  assert.equal(submitted.submission.syllabusId, syllabusId);
  const approvedClass = (await call('/api/classes')).classes.find(item => item.id === id);
  const replacementFile = { ...file, name: 'updated-syllabus.pdf' };
  const replacement = await call('/api/classes', { name: assignment.course, classId: id, version: approvedClass.version, file: replacementFile });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.class.syllabusId, syllabusId);
  assert.equal(replacement.class.status, 'pending');
  assert.equal((await call('/api/submissions', { ...assignment, title: 'New exam after replacement', classId: id })).status, 422);
  const historical = await call(`/api/submissions/${submitted.submission.id}`);
  assert.equal(historical.submission.syllabusId, syllabusId);
  assert.equal((await call(`/api/syllabi/${syllabusId}/evidence`)).name, file.name);
  await call('/api/demo/session', { persona: 'chair' });
  assert.equal((await call(`/api/syllabi/${syllabusId}/evidence`)).name, file.name);
  const pending = (await call('/api/syllabi')).syllabi.find(item => item.id === replacement.class.syllabusId);
  assert.equal((await call(`/api/syllabi/${pending.id}/review`, { decision: 'denied', note: 'Please upload the full syllabus.', version: pending.version })).status, 200);
  await call('/api/demo/session', { persona: 'test1' });
  assert.equal((await call('/api/submissions', { ...assignment, title: 'Denied syllabus exam', classId: id })).status, 422);
  const deniedClass = (await call('/api/classes')).classes.find(item => item.id === id);
  assert.equal((await call(`/api/classes/${id}/archive`, { version: deniedClass.version })).status, 200);
  assert.equal((await call('/api/submissions', { ...assignment, title: 'Archived syllabus exam', classId: id })).status, 422);
  assert.equal((await call(`/api/syllabi/${syllabusId}/evidence`)).status, 200);
}));

test('sandbox Canvas imports and custom graded categories cannot bypass syllabus approval', () => withSandbox(async call => {
  await call('/api/demo/session', { persona: 'test1' });
  const pending = await call('/api/classes', { name: 'MTH 2002', file });
  assert.equal(pending.status, 201);
  const canvas = { confirm: true, items: [{ assignmentId: 2201, activity: 'minor', classId: pending.class.id }] };
  assert.equal((await call('/api/integrations/canvas/import', canvas)).status, 422);
  assert.equal((await call('/api/integrations/canvas/import', { confirm: true, items: [{ assignmentId: 2201, activity: 'minor' }] })).status, 422);
  await call('/api/demo/session', { persona: 'chair' });
  const previous = await call('/api/point-categories');
  const categoryInput = { name: 'Term project', unit: 'project', proof: 'Project grade.', enabled: true, mode: 'grade', rate: 4, minGrade: 90, bands: [], study: false, weeklyLimit: null };
  const edited = await call('/api/point-categories', { version: previous.version, category: categoryInput });
  assert.equal(edited.status, 200);
  const category = edited.categories.find(item => item.name === categoryInput.name);
  await call('/api/demo/session', { persona: 'test1' });
  assert.equal((await call('/api/submissions', { ...assignment, activity: category.id, classId: pending.class.id })).status, 422);
  await call('/api/demo/session', { persona: 'chair' });
  const syllabus = (await call('/api/syllabi')).syllabi.find(item => item.id === pending.class.syllabusId);
  assert.equal((await call(`/api/syllabi/${syllabus.id}/review`, { decision: 'approved', note: '', version: syllabus.version })).status, 200);
  await call('/api/demo/session', { persona: 'test1' });
  const imported = await call('/api/integrations/canvas/import', canvas);
  assert.equal(imported.status, 201);
  assert.equal(imported.imported[0].classId, pending.class.id);
  assert.equal(imported.imported[0].syllabusId, syllabus.id);
  assert.equal((await call('/api/submissions', { ...assignment, activity: category.id, classId: pending.class.id })).status, 201);
  const beforeReset = (await call('/api/submissions')).submissions;
  assert.ok(beforeReset.some(item => item.syllabusId));
  await call('/api/demo/reset', {});
  assert.deepEqual((await call('/api/classes')).classes, []);
  assert.equal((await call(`/api/syllabi/${syllabus.id}/evidence`)).status, 404);
  await call('/api/demo/session', { persona: 'chair' });
  assert.ok((await call('/api/submissions')).submissions.every(item => !item.syllabusId), 'Fictional old submissions stay unchanged.');
}));

test('sandbox protects concurrent reviews and stale legacy edits', () => withSandbox(async (call, store) => {
  await call('/api/demo/session', { persona: 'test1' });
  const session = JSON.parse(store.get('ato-scholarship-demo-data'));
  session.data.memberProfiles = { test1: { courses: ['Legacy Course', 'Course to upgrade'], version: 'legacy-v1' } };
  store.set('ato-scholarship-demo-data', JSON.stringify(session));
  const legacy = (await call('/api/classes')).classes.find(item => item.name === 'Legacy Course');
  assert.equal(legacy.status, 'missing');
  assert.equal((await call('/api/classes/legacy/archive', { name: legacy.name, version: 'wrong' })).status, 409);
  assert.equal((await call('/api/classes/legacy/archive', { name: legacy.name, version: legacy.version })).status, 200);
  assert.ok(!(await call('/api/classes')).classes.some(item => item.name === legacy.name));
  const existing = (await call('/api/classes')).classes.find(item => item.name === 'Course to upgrade');
  assert.equal((await call('/api/classes', { name: existing.name, file, version: 'legacy-v1' })).status, 409);
  const upgraded = await call('/api/classes', { name: existing.name, file, version: existing.version });
  assert.equal(upgraded.status, 201);
  assert.equal((await call('/api/classes/legacy/archive', { name: existing.name, version: existing.version })).status, 404);
  assert.equal((await call('/api/profile')).classes.length, 1);
  assert.equal((await call('/api/profile', { courses: ['No syllabus'], version: 'anything' })).status, 422);
  await call('/api/demo/session', { persona: 'chair' });
  const syllabus = (await call('/api/syllabi')).syllabi[0];
  const decisions = await Promise.all(['approved', 'denied'].map(decision => call(`/api/syllabi/${syllabus.id}/review`, { version: syllabus.version, decision, note: 'Test review decision.' })));
  assert.deepEqual(decisions.map(item => item.status).sort(), [200, 409]);
}));

test('sandbox invalid or oversized syllabus cannot create a partial class', () => withSandbox(async call => {
  await call('/api/demo/session', { persona: 'test1' });
  assert.equal((await call('/api/classes', { name: 'Oversized', file: { ...file, size: 1048577 } })).status, 422);
  assert.deepEqual((await call('/api/classes')).classes, []);
  const oldSetItem = globalThis.sessionStorage.setItem;
  globalThis.sessionStorage.setItem = () => { throw Object.assign(Error('Full'), { name: 'QuotaExceededError' }); };
  const denied = await call('/api/classes', { name: 'Storage limit', file });
  assert.equal(denied.status, 507);
  assert.match(denied.error, /storage is full/i);
  globalThis.sessionStorage.setItem = oldSetItem;
  assert.deepEqual((await call('/api/classes')).classes, []);
}));
