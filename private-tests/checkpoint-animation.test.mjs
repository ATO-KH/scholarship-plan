import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const source = await readFile(new URL('../web/celebrations.js', import.meta.url), 'utf8');
const input = { memberId: 'fictional', role: 'member', approved: 0, today: '2026-11-10', checkpoints: [{ date: '2026-10-10' }, { date: '2026-11-10' }], semesterKey: 'fall-2026' };
function fixture(t, reduced = false) {
  const w = new Window({ url: 'https://portal.example.test/' });
  Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
  w.matchMedia = () => ({ matches: reduced });
  w.eval(source);
  t.after(async () => { w.atoCelebrate.stop(); await w.happyDOM.close(); });
  return w;
}

test('tomatoes do not repeat on dashboard redraws but replay on refresh, ignoring old browser storage', t => {
  const w = fixture(t);
  w.localStorage.setItem('ato-checkpoint-tomato:fictional:fall-2026:2026-10-10', 'seen');
  assert.equal(w.atoCelebrate.checkpoint(input), true);
  assert.ok(w.document.querySelectorAll('.tomato-impact').length > 3);
  assert.equal(w.document.querySelector('.checkpoint-tomato').getAttribute('aria-hidden'), 'true');
  w.document.dispatchEvent(new w.Event('pointerdown'));
  assert.ok(w.document.querySelector('.checkpoint-tomato'), 'ordinary clicks do not clear lingering splats');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a' }));
  assert.ok(w.document.querySelector('.checkpoint-tomato'), 'typing keeps the slow fade playing');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(w.document.querySelector('.checkpoint-tomato'), null);
  assert.equal(w.atoCelebrate.checkpoint(input), false);
  w.eval(source);
  assert.equal(w.atoCelebrate.checkpoint(input), true, 'refresh starts a new barrage');
  assert.equal(w.atoCelebrate.checkpoint({ ...input, today: '2026-11-11' }), true, 'a later missed checkpoint may play once');
  w.dispatchEvent(new w.Event('hashchange'));
  assert.equal(w.document.querySelector('.checkpoint-tomato'), null);
});

test('tomatoes grow weekly, jump at checkpoints two and three, then double weekly with a bounded maximum', t => {
  const checkpoints = ['2026-09-12', '2026-10-10', '2026-11-06', '2026-12-04'].map(date => ({ date }));
  const examples = [
    ['2026-09-12', 0], ['2026-09-13', 3], ['2026-09-19', 5],
    ['2026-10-10', 11], ['2026-10-11', 14], ['2026-10-17', 18],
    ['2026-11-06', 26], ['2026-11-07', 32], ['2026-11-13', 64],
    ['2026-11-20', 96], ['2026-12-05', 96],
  ];
  for (const [today, count] of examples) {
    const w = fixture(t);
    w.atoCelebrate.checkpoint({ ...input, checkpoints, today });
    assert.equal(w.document.querySelectorAll('.tomato-impact').length, count, today);
  }
});

test('the full barrage lingers for its final splat and removes itself without a long-running timer per tomato', t => {
  const w = fixture(t), timers = [];
  w.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return 1; };
  w.clearTimeout = () => {};
  w.atoCelebrate.checkpoint(input);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 14000 && timers[0].delay < 17000);
  assert.ok(new Set(Array.from(w.document.querySelectorAll('.tomato-impact'), impact => impact.style.getPropertyValue('--impact-x'))).size > 1);
  timers[0].callback();
  assert.equal(w.document.querySelector('.checkpoint-tomato'), null);
});

test('tomato is suppressed for Chairs, nonzero points, due/future checkpoints, reduced motion and hidden pages', t => {
  const w = fixture(t);
  for (const extra of [{ role: 'chair' }, { approved: 1 }, { approved: -1 }, { approved: undefined }, { today: '2026-10-10' }, { checkpoints: [] }])
    assert.equal(w.atoCelebrate.checkpoint({ ...input, ...extra }), false);
  Object.defineProperty(w.document, 'hidden', { value: true, configurable: true });
  assert.equal(w.atoCelebrate.checkpoint(input), false);
  assert.equal(fixture(t, true).atoCelebrate.checkpoint(input), false);
});
