import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHECKPOINT_QUOTAS, validateCheckpointQuotas, checkpointQuotaView } from "../web/checkpoint-data.mjs";

test("quota validation enforces cumulative whole points and tier ordering", () => {
  const valid = [[0, 0, 1, 2, 3], [0, 0, 1, 2, 3], [1, 1, 1, 2, 3], [1, 1, 2, 3, 10_000]];
  assert.deepEqual(validateCheckpointQuotas(valid), valid);
  for (const input of [null, {}, [], [...valid, valid[3]], valid.map(row => row.slice(0, 4))])
    assert.throws(() => validateCheckpointQuotas(input), { status: 422 });
  for (const value of [null, "1", true, -1, 1.5, NaN, Infinity, 10_001]) {
    const bad = structuredClone(DEFAULT_CHECKPOINT_QUOTAS);
    bad[0][0] = value;
    assert.throws(() => validateCheckpointQuotas(bad), { status: 422 });
  }
  const dropsAtCheckpoint = structuredClone(DEFAULT_CHECKPOINT_QUOTAS);
  dropsAtCheckpoint[1][0] = 9;
  const dropsAtTier = structuredClone(DEFAULT_CHECKPOINT_QUOTAS);
  dropsAtTier[0][1] = 9;
  assert.throws(() => validateCheckpointQuotas(dropsAtCheckpoint), { status: 422 });
  assert.throws(() => validateCheckpointQuotas(dropsAtTier), { status: 422 });
  assert.throws(() => validateCheckpointQuotas(Array.from({ length: 4 }, () => [0, 0, 0, 0, 0])), { status: 422 });
});

test("views derive goals from saved quotas, clone data, and version across semesters", () => {
  const dates = ["2027-02-01", "2027-03-01", "2027-04-01", "2027-05-01"];
  const defaults = checkpointQuotaView();
  assert.deepEqual(defaults.checkpoints.map(item => item.targets), DEFAULT_CHECKPOINT_QUOTAS);
  const targets = DEFAULT_CHECKPOINT_QUOTAS.map(row => row.map(points => points * 2));
  const state = { checkpointQuotas: targets, checkpointQuotaRevision: 3, semesterGeneration: "fall" };
  const view = checkpointQuotaView(state, dates);
  assert.deepEqual(view.checkpoints.map(item => item.date), dates);
  assert.equal(view.version, "fall:3");
  assert.deepEqual(view.checkpoints.at(-1).targets, targets.at(-1));
  view.checkpoints[0].targets[0] = 999;
  assert.equal(targets[0][0], 20);
  const validated = validateCheckpointQuotas(targets);
  validated[0][0] = 999;
  assert.equal(targets[0][0], 20);
  assert.notEqual(checkpointQuotaView({ semesterGeneration: "spring" }).version, defaults.version);
});
