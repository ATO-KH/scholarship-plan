import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../web/demo/demo-service.mjs';

const fixed = { name: 'Academic workshop', unit: 'workshop', proof: 'Attendance record.', enabled: true, mode: 'fixed', rate: 7, minGrade: 0, bands: [], study: false, weeklyLimit: null };

test('sandbox category edits affect future claims while preserving previous claims', async () => {
  const originalStorage = globalThis.sessionStorage;
  const store = new Map();
  globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const call = async (path, body) => {
    const response = await handle(new Request(`https://demo.test/demo${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), path);
    return { status: response.status, ...await response.json() };
  };
  try {
    await call('/api/demo/session', { persona: 'chair' });
    const original = await call('/api/point-categories');
    const added = await call('/api/point-categories', { version: original.version, category: fixed });
    assert.equal(added.status, 200);
    const category = added.categories.find(item => item.name === fixed.name);
    assert.ok(category?.id);
    assert.equal((await call('/api/point-categories', { version: original.version, category: fixed })).status, 409);
    await call('/api/demo/session', { persona: 'test1' });
    assert.equal((await call('/api/point-categories')).status, 403);
    assert.equal((await call('/api/point-categories', { version: added.version, category: fixed })).status, 403);
    const claim = { activity: category.id, title: 'Workshop activity', course: 'MTH 2002', date: '2026-09-28', evidence: 'sample', confirm: true };
    const submitted = await call('/api/submissions', claim);
    assert.equal(submitted.status, 201);
    assert.equal(submitted.submission.estimate, 7);
    await call('/api/demo/session', { persona: 'chair' });
    const changed = await call('/api/point-categories', { version: added.version, category: { ...fixed, id: category.id, name: 'Renamed workshop', rate: 12, enabled: false } });
    assert.equal(changed.status, 200);
    await call('/api/demo/session', { persona: 'test1' });
    assert.equal((await call('/api/submissions', { ...claim, title: 'Stale form', categoryVersion: added.version })).status, 409);
    assert.equal((await call('/api/submissions', { ...claim, title: 'Second workshop' })).status, 422);
    const old = (await call(`/api/submissions/${submitted.submission.id}`)).submission;
    assert.equal(old.estimate, 7);
    assert.equal(old.activitySnapshot.name, fixed.name);
    const evidence = await call(`/api/submissions/${submitted.submission.id}/evidence`);
    assert.equal(evidence.evidence.activity, fixed.name);
    const rules = await call('/api/rules');
    assert.equal(rules.activities.find(item => item.id === category.id).enabled, false);
  } finally { globalThis.sessionStorage = originalStorage; }
});
