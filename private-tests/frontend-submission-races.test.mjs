import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const item = id => ({ id, memberName: 'Fictional member', title: 'Claim ' + id, status: 'approved',
  course: 'Fictional', date: '2026-11-09', grade: null, awarded: 5, history: [] });

test('a delayed detail response cannot replace a newer selection or a dialog opened in the meantime', async () => {
  const requests = new Map(), dialogs = [];
  const context = { user: { id: 'member', role: 'member' }, sessionEpoch: 0, modalRevision: 0,
    api: path => { const next = deferred(); requests.set(path, next); return next.promise; },
    submissionActivity: () => ({ name: 'Study', proof: 'Proof' }), esc: String, status: () => '', date: String, money: String,
    openModal: (title, subtitle) => { context.modalRevision++; dialogs.push(subtitle); }, evidence() {}, toast: assert.fail,
  };
  const detail = runInNewContext('(' + extract('async function detail(', '\nasync function review(') + ')', context);
  const first = detail('A'), second = detail('B');
  requests.get('/api/submissions/B').resolve({ submission: item('B') }); await second;
  requests.get('/api/submissions/A').resolve({ submission: item('A') }); await first;
  assert.deepEqual(dialogs, ['B · Fictional member']);
  const third = detail('C');
  context.openModal('New claim', 'Unsaved work');
  requests.get('/api/submissions/C').resolve({ submission: item('C') }); await third;
  assert.equal(dialogs.at(-1), 'Unsaved work');
});

for (const failure of [false, true]) test(`a delayed review ${failure ? 'error' : 'success'} leaves a replacement form open`, async () => {
  const request = deferred(), feedback = [];
  const context = { busy: false, user: { id: 'chair' }, sessionEpoch: 2,
    FormData: class { constructor() { return [['points', '5'], ['note', 'Reviewed']]; } },
    api: async (path, options) => { assert.equal(options.body.version, 'review-version'); return request.promise; },
    modal: { open: true, close() { this.open = false; } }, refresh: async () => feedback.push('refresh'),
    toast: message => feedback.push(message), formError: message => feedback.push(message),
  };
  const review = runInNewContext('(' + extract('async function review(', '\nasync function evidence(') + ')', context);
  const form = { isConnected: true, dataset: { id: 'A', version: 'review-version' }, querySelectorAll: () => [] };
  const pending = review({ preventDefault() {}, submitter: { value: 'approved' }, target: form });
  form.isConnected = false;
  if (failure) request.reject(Error('Old request failed')); else request.resolve({});
  await pending;
  assert.equal(context.modal.open, true);
  assert.deepEqual(feedback, []);
  assert.equal(context.busy, false);
});

test('list loading restarts once after a changed snapshot and never mixes records', async () => {
  const calls = [];
  const context = { user: { id: 'chair' }, sessionEpoch: 0, encodeURIComponent,
    api: async path => {
      calls.push(path);
      if (calls.length === 1) return { submissions: [{ id: 'old' }], nextCursor: 'old-version' };
      if (calls.length === 2) throw Object.assign(Error('changed'), { status: 409 });
      if (calls.length === 3) return { submissions: [{ id: 'new-1' }], nextCursor: 'new-version' };
      return { submissions: [{ id: 'new-2' }], nextCursor: null };
    },
  };
  const load = runInNewContext('(' + extract('async function loadSubmissionList()', '\nasync function refresh()') + ')', context);
  assert.deepEqual(Array.from((await load()).submissions, item => item.id), ['new-1', 'new-2']);
  assert.deepEqual(calls, ['/api/submissions', '/api/submissions?cursor=old-version', '/api/submissions', '/api/submissions?cursor=new-version']);
});

test('list loading stops when the account changes instead of requesting another page', async () => {
  const request = deferred();
  let calls = 0;
  const context = { user: { id: 'chair' }, sessionEpoch: 0, encodeURIComponent, api: () => { calls++; return request.promise; } };
  const load = runInNewContext('(' + extract('async function loadSubmissionList()', '\nasync function refresh()') + ')', context);
  const work = load();
  context.sessionEpoch++;
  request.resolve({ submissions: [{ id: 'private' }], nextCursor: 'more' });
  await assert.rejects(work, /Account changed/);
  assert.equal(calls, 1);
});
