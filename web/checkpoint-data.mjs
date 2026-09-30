// Shared by the authenticated portal and the session-only demonstration.
export const DEFAULT_CHECKPOINT_QUOTAS = Object.freeze([
  Object.freeze([10, 14, 18, 23, 30]),
  Object.freeze([20, 28, 36, 46, 60]),
  Object.freeze([30, 42, 54, 70, 90]),
  Object.freeze([40, 55, 70, 90, 120]),
]);
const DEFAULT_DATES = ["2026-09-12", "2026-10-10", "2026-11-06", "2026-12-04"];

export function validateCheckpointQuotas(targets) {
  const fail = (message) => { throw Object.assign(Error(message), { status: 422 }); };
  if (!Array.isArray(targets) || targets.length !== 4 ||
      targets.some(row => !Array.isArray(row) || row.length !== 5))
    fail("Enter all four checkpoint quotas for each of the five tiers.");
  for (let checkpoint = 0; checkpoint < 4; checkpoint++) {
    for (let tier = 0; tier < 5; tier++) {
      const value = targets[checkpoint][tier];
      if (!Number.isInteger(value) || value < 0 || value > 10_000)
        fail("Point quotas must be whole numbers from 0 to 10,000.");
      if (checkpoint === 3 && value === 0)
        fail("Each final semester goal must be at least one point.");
      if (checkpoint > 0 && value < targets[checkpoint - 1][tier])
        fail(`Tier ${tier + 1} quotas must stay the same or increase at each checkpoint.`);
      if (tier > 0 && value < targets[checkpoint][tier - 1])
        fail("A higher tier cannot have a lower point quota than the preceding tier.");
    }
  }
  return targets.map(row => [...row]);
}

export function checkpointQuotaView(state = {}, dates = DEFAULT_DATES) {
  const targets = state.checkpointQuotas ?? DEFAULT_CHECKPOINT_QUOTAS;
  return {
    checkpoints: targets.map((row, index) => ({ date: dates[index], targets: [...row] })),
    version: `${state.semesterGeneration || "initial"}:${state.checkpointQuotaRevision || 0}`,
  };
}
