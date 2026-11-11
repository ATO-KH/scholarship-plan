import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { creditLoadView, confirmCreditLoad, refreshCreditLoadEstimates } from '../web/credit-load-data.mjs';
import { mountCreditLoad } from '../web/credit-load-ui.mjs';
import { pointBreakdown, applyPointAdjustment, pointAdjustmentView } from '../web/point-adjustment-data.mjs';
import { leaderboardView } from '../web/leaderboard-data.mjs';

test('old partial-load estimates become neutral; only confirmed full loads affect pending work', () => {
  const state = { classRecords: [{ id: 'c', owner: 'm', approvedCredits: 3 }], submissions: [
    { owner: 'm', status: 'pending', base: 5, estimate: 7.5 },
    { owner: 'm', status: 'approved', base: 5, estimate: 7.5, awarded: 7.5 },
  ] };
  refreshCreditLoadEstimates(state);
  assert.equal(state.submissions[0].estimate, 5);
  const options = { reviewer: 'Chair', at: 'now', newVersion: () => 'confirmed' };
  const version = creditLoadView(state, 'm').version;
  assert.throws(() => confirmCreditLoad(state, 'm', { credits: 2, version }, options), { status: 422 });
  confirmCreditLoad(state, 'm', { credits: 12, version }, options);
  assert.equal(state.submissions[0].estimate, 5.75);
  assert.equal(state.submissions[1].awarded, 7.5);
  state.classRecords.push({ id: 'new', owner: 'm', approvedCredits: 10 });
  assert.equal(creditLoadView(state, 'm').needsReview, true);
  refreshCreditLoadEstimates(state);
  assert.equal(state.submissions[0].estimate, 5);
  state.semesterGeneration = 'next';
  assert.throws(() => confirmCreditLoad(state, 'm', { credits: 15, version }, options), { status: 409 });
});

test('decimal awards and adjustments keep exact hundredth totals and leaderboard ties', () => {
  const state = { submissions: [{ owner: 'a', status: 'approved', awarded: 0.1 }, { owner: 'a', status: 'approved', awarded: 0.2 }, { owner: 'b', status: 'approved', awarded: 0.3 }] };
  assert.equal(pointBreakdown(state, 'a').approved, 0.3);
  const people = ['a', 'b'].map(id => ({ id, name: id, active: true, role: 'member' }));
  assert.deepEqual(leaderboardView(state, people, 'a').members.map(row => row.place), [1, 1]);
  applyPointAdjustment(state, people[0], { version: pointAdjustmentView(state, people[0]).version, total: 5.75, reason: 'Prior credit' }, { name: 'Chair', id: 'chair' }, 'adjustment', 'now');
  assert.equal(pointBreakdown(state, 'a').approved, 5.75);
  assert.equal(state.pointAdjustments[0].delta, 5.45);
});

test('full-load form requires a deliberate schedule confirmation and saves decimal hours once', async t => {
  const w = new Window(), original = globalThis.document;
  globalThis.document = w.document;
  t.after(async () => { globalThis.document = original; await w.happyDOM.close(); });
  const container = w.document.createElement('section'); w.document.body.append(container);
  const calls = [], view = { confirmed: false, credits: null, approvedCredits: 3, multiplier: 1, version: 'v1' };
  const api = async (path, options) => { calls.push({ path, body: options.body }); return { creditLoad: { ...view, confirmed: true, credits: 12.25, multiplier: 1.15, version: 'v2' } }; };
  await mountCreditLoad(container, { owner: 'm', view, api, esc: String, loading: String });
  const form = container.querySelector('form');
  assert.equal(form.elements.credits.value, '', 'Do not suggest a partial approved total as the full schedule.');
  assert.equal(form.elements.credits.step, '0.01');
  // Happy DOM uses floating-point remainder for step validation, so even valid
  // hundredths fail there. Leave the other native required/range checks active.
  form.elements.credits.step = 'any';
  form.elements.credits.value = '12.25';
  await form.onsubmit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  form.elements.confirm.checked = true;
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(calls, [{ path: '/api/roster/m/credit-load', body: { credits: 12.25, version: 'v1' } }]);
  assert.match(container.textContent, /12.25 hours · 1.15×/);
});
