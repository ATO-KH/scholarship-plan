import test from 'node:test';
import assert from 'node:assert/strict';
import { runOperationsRehearsal } from '../scripts/rehearse-operations.mjs';

test('fictional backup restores actual file bytes, resumes interrupted cleanup and reapplies deletion after old restore', async () => {
  const result = await runOperationsRehearsal();
  assert.equal(result.fictionalOnly, true);
  assert.equal(result.cleanedUp, true);
  assert.equal(result.checks.length, 6);
  assert.match(result.limitations[0], /no live Supabase/);
});

for (const fault of ['missing-object', 'corrupt-object', 'unexpected-path']) {
  test(`backup ${fault} fails closed without a partial restore`, async () => {
    const result = await runOperationsRehearsal({ fault });
    assert.equal(result.cleanedUp, true);
    assert.match(result.checks[0], /rejected before restoration/);
  });
}
