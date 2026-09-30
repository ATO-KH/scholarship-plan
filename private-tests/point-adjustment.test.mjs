import test from 'node:test';
import assert from 'node:assert/strict';
import { pointAdjustmentView, applyPointAdjustment } from '../web/point-adjustment-data.mjs';
import { handle } from '../web/demo/demo-service.mjs';

test('manual credits are final points, append corrections, and reject stale semesters without mutation', () => {
  const state = { submissions: [{ id: 's', owner: 'a', status: 'approved', awarded: 8 }] };
  const member = { id: 'a', name: 'Member', credits: 8 }, chair = { id: 'chair', name: 'Chair' };
  const initial = pointAdjustmentView(state, member);
  const changed = applyPointAdjustment(state, member, { version: initial.version, total: 28, reason: 'Previous points' }, chair, 'one', '2026-09-30T12:00:00Z');
  assert.equal(changed.adjustmentPoints, 20);
  assert.equal(changed.submissionPoints, 8);
  assert.equal(changed.history[0].actorId, 'chair');
  const reset = applyPointAdjustment(state, member, { version: changed.version, total: 8, reason: 'Remove mistaken credit' }, chair, 'two', '2026-09-30T12:01:00Z');
  assert.equal(reset.history[0].delta, -20);
  assert.equal(reset.history.length, 2);
  assert.equal(reset.adjustmentPoints, 0);
  state.semesterGeneration = 'new-semester';
  assert.throws(() => applyPointAdjustment(state, member, { version: reset.version, total: 100, reason: 'Old form' }, chair, 'three', ''), { status: 409 });
  assert.equal(state.pointAdjustments.length, 2);
});

test('sandbox adjustments persist in this session, are private to owner, and reset with the demo', async () => {
  const original = globalThis.sessionStorage, store = new Map();
  globalThis.sessionStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const call = async (path, body) => {
    const response = await handle(new Request(`https://demo.test/demo${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), path);
    return { status: response.status, ...await response.json() };
  };
  try {
    await call('/api/demo/session', { persona: 'chair' });
    const path = '/api/members/test1/point-adjustments';
    const initial = await call(path);
    const body = { version: initial.version, total: 20, reason: 'Prior points' };
    const saved = await call(path, body);
    assert.equal(saved.status, 200);
    assert.equal(saved.approved, 20);
    assert.equal((await call(path, body)).status, 409);
    await call('/api/demo/session', { persona: 'test1' });
    assert.equal((await call('/api/points')).approved, 20);
    assert.equal((await call(path)).history[0].reason, 'Prior points');
    assert.equal((await call(path, { ...body, version: saved.version, total: 30 })).status, 403);
    await call('/api/demo/session', { persona: 'alex' });
    assert.equal((await call(path)).status, 404);
    await call('/api/demo/reset', {});
    await call('/api/demo/session', { persona: 'chair' });
    assert.equal((await call(path)).history.length, 0);
  } finally { globalThis.sessionStorage = original; }
});
