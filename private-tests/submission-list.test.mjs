import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionPage, submissionReviewVersion } from '../server/submission-list.mjs';

const fixture = () => ({ semesterGeneration: 'fall', submissions: Array.from({ length: 705 }, (_, index) => ({
  id: String(index).padStart(4, '0'), owner: index % 2 ? 'other' : 'member', submittedAt: '2026-10-01T00:00:00.000Z',
  title: 'Fictional work', estimate: 5, status: 'pending', history: [{ event: 'private history' }],
  note: 'private member note', evidenceId: 'private-file', syllabus: { grade: 99 }, activitySnapshot: { name: 'Quiz', proof: 'details' },
})) });

test('submission pages have stable order, bounded sizes and no evidence or long histories', () => {
  const state = fixture(), names = new Map([['member', 'Member']]);
  let cursor, found = [];
  do {
    const page = submissionPage(state, { role: 'chair' }, names, new URLSearchParams(cursor ? { cursor } : {}));
    assert.ok(page.submissions.length <= 200);
    assert.equal(page.total, 705);
    for (const item of page.submissions) {
      assert.ok(!('history' in item || 'syllabus' in item || 'note' in item || 'evidenceId' in item));
      assert.deepEqual(item.activitySnapshot, { name: 'Quiz' });
    }
    found.push(...page.submissions.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found, state.submissions.map(item => item.id));
  const member = submissionPage(state, { id: 'member', role: 'member' }, names, new URLSearchParams({ limit: '500' }));
  assert.equal(member.total, 353);
  assert.ok(member.submissions.every(item => item.owner === 'member' && item.memberName === 'Member'));
});

test('submission pagination rejects malformed cursors and concurrent changes instead of dropping records', () => {
  const state = fixture(), user = { role: 'chair' }, names = new Map();
  for (const params of [{ limit: '501' }, { limit: '0' }, { limit: '-1' }, { cursor: 'bad!' }, { cursor: 'bnVsbA' }])
    assert.throws(() => submissionPage(state, user, names, new URLSearchParams(params)), error => error.status === 422);
  const { nextCursor } = submissionPage(state, user, names);
  state.submissions[0].estimate = 7.5;
  assert.throws(() => submissionPage(state, user, names, new URLSearchParams({ cursor: nextCursor })), error => error.status === 409);
});

test('review versions change with the estimate, evidence and semester generation', () => {
  const state = fixture(), item = state.submissions[0], original = submissionReviewVersion(state, item);
  assert.equal(submissionReviewVersion(state, { ...item }), original);
  for (const changed of [{ ...item, estimate: 7.5 }, { ...item, evidenceId: 'replacement' }])
    assert.notEqual(submissionReviewVersion(state, changed), original);
  assert.notEqual(submissionReviewVersion({ ...state, semesterGeneration: 'spring' }, item), original);
});
