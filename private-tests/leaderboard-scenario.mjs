import assert from 'node:assert/strict';

export async function leaderboardScenario(call) {
  await call('/api/demo/session', { persona: 'alex' });
  assert.equal((await call('/api/members')).status, 403);
  let view = await call('/api/leaderboard');
  assert.equal(view.status, 200);
  for (const row of view.members) assert.deepEqual(Object.keys(row).sort(), ['isYou', 'name', 'place', 'points']);
  const before = view.members.find(member => member.isYou).points;
  const today = (await call('/api/me')).today;
  const submitted = await call('/api/submissions', { activity: 'office', title: 'Leaderboard verification', course: 'General studies', date: today, quantity: 1, evidence: 'sample', confirm: true });
  assert.equal(submitted.status, 201);
  assert.equal((await call('/api/leaderboard')).members.find(member => member.isYou).points, before, 'pending estimates must not count');
  await call('/api/demo/session', { persona: 'chair' });
  const path = `/api/submissions/${submitted.submission.id}`;
  let detail = (await call(path)).submission;
  assert.equal((await call(path + '/review', { decision: 'denied', points: 0, note: 'Initial decision', version: detail.reviewVersion })).status, 200);
  detail = (await call(path)).submission;
  assert.equal((await call(path + '/revise', { decision: 'approved', points: 7, note: 'Correct evidence verified', version: detail.reviewVersion })).status, 200);
  await call('/api/demo/session', { persona: 'alex' });
  assert.equal((await call('/api/leaderboard')).members.find(member => member.isYou).points, before + 7);
  await call('/api/demo/session', { persona: 'chair' });
  let adjustment = await call('/api/members/alex/point-adjustments');
  assert.equal((await call('/api/members/alex/point-adjustments', { version: adjustment.version, total: 100, reason: 'Leaderboard adjustment verification' })).status, 200);
  const chairView = await call('/api/leaderboard');
  assert.equal(chairView.yourLead, null);
  assert.ok(chairView.members.every(row => !row.isYou));
  assert.ok(!chairView.members.some(row => row.name === 'Taylor Morgan'));
  await call('/api/demo/session', { persona: 'alex' });
  view = await call('/api/leaderboard');
  assert.equal(view.members[0].points, 100);
  assert.equal(view.members[0].isYou, true);
  assert.deepEqual(view.yourLead, { points: 100, shared: false });
}
