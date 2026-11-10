import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { leaderboardView } from '../web/leaderboard-data.mjs';
import { leaderGraphic, mountLeaderHonor, mountLeaderboard } from '../web/leaderboard-ui.mjs';

const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const tick = () => new Promise(resolve => setImmediate(resolve));
const member = (id, extra = {}) => ({ id, name: id, active: true, role: 'member', email: `${id}@example.test`, gpa: 3, ...extra });
const awards = values => ({ submissions: Object.entries(values).map(([owner, awarded]) => ({ owner, awarded, status: 'approved' })) });

test('leaderboard counts approved awards and adjustments, removes private fields, and excludes inactive/chair/pilot accounts', () => {
  const state = awards({ a: 12, b: 11, inactive: 100, chair: 200, pilot: 300 });
  state.submissions.push({ owner: 'b', status: 'pending', estimate: 999, awarded: 0 }, { owner: 'b', status: 'denied', awarded: 50 });
  state.pointAdjustments = [{ owner: 'b', delta: 4 }, { owner: 'a', delta: -2 }];
  const people = [member('a'), member('b'), member('inactive', { active: false }), member('chair', { role: 'chair' }), member('pilot', { email: 'pilot@pilot.invalid' })];
  assert.deepEqual(leaderboardView(state, people, 'b'), {
    members: [{ name: 'b', points: 15, isYou: true, place: 1 }, { name: 'a', points: 10, isYou: false, place: 2 }],
    yourLead: { points: 15, shared: false },
  });
});

test('tied scores share medals, only top three places get labels, and zero points never gets a medal', () => {
  const people = ['a', 'b', 'c', 'd', 'e'].map(id => member(id));
  const view = leaderboardView(awards({ a: 20, b: 20, c: 18, d: 10, e: 0 }), people, 'b');
  assert.deepEqual(view.members.map(row => row.place), [1, 1, 3, null, null]);
  assert.deepEqual(view.yourLead, { points: 20, shared: true });
  assert.equal(leaderboardView(awards({ a: 0, b: 0 }), people, 'a').yourLead, null);
  assert.ok(leaderboardView(awards({ a: 0, b: 0 }), people, 'a').members.every(row => row.place === null));
  assert.equal(leaderboardView(awards({ a: -2, b: -3 }), people.slice(0, 2), 'a').yourLead, null);
});

function fixture(t) {
  const w = new Window();
  t.after(() => w.happyDOM.close());
  const container = w.document.createElement('section'); w.document.body.append(container);
  return { w, container };
}

test('podium has gold/silver/bronze names and the rest is an unnumbered list; search preserves places and escapes names', async t => {
  const { w, container } = fixture(t);
  const view = leaderboardView(awards({ a: 30, b: 20, c: 10, d: 5, e: 0 }), [member('a', { name: 'Alex <script>' }), member('b'), member('c'), member('d'), member('e')], 'd');
  await mountLeaderboard(container, { api: async () => view, esc, loading: () => 'Loading', isCurrent: () => true });
  assert.equal(container.querySelectorAll('.podium-place').length, 3);
  assert.equal(container.querySelector('.medal-gold strong').textContent, 'Alex <script>');
  assert.equal(container.querySelector('.medal-silver h3').textContent, '2nd');
  assert.equal(container.querySelector('.medal-bronze h3').textContent, '3rd');
  assert.equal(container.querySelectorAll('.leaderboard-list li').length, 2);
  assert.match(container.querySelector('.leaderboard-list .leaderboard-you').textContent, /You/);
  assert.doesNotMatch(container.textContent, /4th|5th/);
  assert.equal(container.querySelector('script'), null);
  const input = container.querySelector('input'); input.value = 'c'; input.dispatchEvent(new w.Event('input'));
  assert.equal(container.querySelector('.medal-bronze h3').textContent, '3rd');
  input.value = 'absent'; input.dispatchEvent(new w.Event('input'));
  assert.match(container.textContent, /No matching members/);
});

test('failed leaderboard loads can retry and late responses cannot populate an old account view', async t => {
  const { container } = fixture(t);
  let fails = true;
  const api = async () => { if (fails) throw Error('Please retry'); return { members: [], yourLead: null }; };
  await mountLeaderboard(container, { api, esc, loading: () => 'Loading', isCurrent: () => true });
  assert.equal(container.querySelector('input').disabled, true);
  fails = false; container.querySelector('button').click(); await tick();
  assert.match(container.textContent, /No members yet/);
  let complete, current = true;
  const load = mountLeaderboard(container, { api: () => new Promise(resolve => complete = resolve), esc, loading: () => 'Loading', isCurrent: () => current });
  current = false; complete({ members: [{ name: 'Old account data', points: 5, place: 1 }], yourLead: null }); await load;
  assert.doesNotMatch(container.textContent, /Old account data/);
});

test('personal recognition appears only for a positive first-place member and handles a shared lead', async t => {
  const { container } = fixture(t);
  assert.equal(leaderGraphic(null, esc), '');
  assert.equal(leaderGraphic({ points: 0 }, esc), '');
  await mountLeaderHonor(container, { api: async () => ({ yourLead: { points: 30, shared: true } }), esc, isCurrent: () => true });
  assert.match(container.textContent, /Sharing the lead|tied for first/);
  assert.ok(container.querySelector('svg'));
  await mountLeaderHonor(container, { api: async () => ({ yourLead: null }), esc, isCurrent: () => true });
  assert.equal(container.innerHTML, '');
});
