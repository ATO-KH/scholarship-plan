import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

for (const path of ['../web/app.js', '../web/demo/app.js']) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const label = path.includes('/demo/') ? 'sandbox' : 'production';

  function fixture() {
    const requests = new Map(), dialogs = [], rendered = [];
    const pending = { isConnected: true, innerHTML: '' }, control = { addEventListener() {} };
    const context = {
      user: { id: 'fictional-member', role: 'member', credits: 15 }, sessionEpoch: 3,
      rules: { activities: [], today: '2026-09-28' }, points: { multiplier: 1 }, submissions: [], roster: [],
      api: path => { const request = deferred(); requests.set(path, request); return request.promise; },
      render: () => rendered.push({ credits: context.user.credits, multiplier: context.points.multiplier }),
      modal: { open: true }, $: selector => selector === '#submission-loading' ? pending : control,
      openModal: (title, subtitle, body) => dialogs.push(body), loading: () => 'Loading', esc: String,
      activeActivities: () => context.rules.activities, isDemo: () => false, money: String,
      activityPicker: () => '', wireActivityPicker() {}, loadCoursePicker() {}, updateForm() {},
      uploadEvidence() {}, estimate() {}, submitClaim() {},
    };
    const resolve = () => {
      const values = {
        '/api/me': { user: { id: 'fictional-member', role: 'member', credits: 3 } },
        '/api/points': { multiplier: 1.5 },
        '/api/rules': { activities: [{ id: 'major' }], today: '2026-09-28' },
        '/api/submissions': { submissions: [{ id: 'fictional-new' }] },
      };
      for (const [path, request] of requests) request.resolve(values[path]);
    };
    return { context, requests, dialogs, rendered, pending, resolve };
  }

  test(`${label} refresh presents updated account hours and multiplier together`, async () => {
    const f = fixture();
    const refresh = runInNewContext(`(${extract('async function refresh()', '\nfunction rows(')})`, f.context);
    const work = refresh();
    assert.ok(f.requests.has('/api/me'));
    f.resolve(); await work;
    assert.deepEqual(f.rendered, [{ credits: 3, multiplier: 1.5 }]);
    assert.equal(f.context.submissions[0].id, 'fictional-new');
  });

  test(`${label} submission form fetches current credit-load estimate before displaying it`, async () => {
    const f = fixture();
    const open = runInNewContext(`(${extract('async function newSubmission()', '\nfunction updateSubmissionPrompts(')})`, f.context);
    const work = open();
    assert.deepEqual([...f.requests.keys()].sort(), ['/api/me', '/api/points', '/api/rules']);
    assert.equal(f.dialogs.length, 1, 'only the loading view is displayed while the refresh is pending');
    f.resolve(); await work;
    assert.equal(f.context.user.credits, 3);
    assert.match(f.dialogs[1], /1\.5× credit multiplier/);
  });

  test(`${label} refresh and submission callbacks cannot restore a superseded account session`, async () => {
    for (const [start, end] of [
      ['async function refresh()', '\nfunction rows('],
      ['async function newSubmission()', '\nfunction updateSubmissionPrompts('],
    ]) {
      const f = fixture();
      const run = runInNewContext(`(${extract(start, end)})`, f.context);
      const work = run();
      const replacement = { id: 'fictional-member', role: 'member', credits: 12 };
      f.context.user = replacement;
      f.context.sessionEpoch++;
      f.resolve(); await work;
      assert.equal(f.context.user, replacement, 'even a new session for the same username owns its current state');
      assert.equal(f.context.points.multiplier, 1);
      assert.equal(f.rendered.length, 0);
      assert.ok(f.dialogs.length <= 1, 'no stale submission form replaces the loading dialog');
    }
  });
}
