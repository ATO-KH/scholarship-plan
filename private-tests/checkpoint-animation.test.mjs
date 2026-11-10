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

test('tomato plays for zero approved points after a checkpoint, once per member/semester/checkpoint even across reloads', t => {
  const w = fixture(t);
  assert.equal(w.atoCelebrate.checkpoint(input), true);
  assert.equal(w.document.querySelectorAll('.checkpoint-tomato svg').length, 2);
  assert.equal(w.document.querySelector('.checkpoint-tomato').getAttribute('aria-hidden'), 'true');
  w.document.dispatchEvent(new w.Event('pointerdown'));
  assert.equal(w.document.querySelector('.checkpoint-tomato'), null);
  assert.equal(w.atoCelebrate.checkpoint(input), false);
  w.eval(source);
  assert.equal(w.atoCelebrate.checkpoint(input), false, 'reload must not repeat the same checkpoint');
  assert.equal(w.atoCelebrate.checkpoint({ ...input, today: '2026-11-11' }), true, 'a later missed checkpoint may play once');
  w.dispatchEvent(new w.Event('hashchange'));
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
