const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const validHours = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 30 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
export const creditMultiplier = credits => credits < 9 ? 1.5 : credits < 12 ? 1.3 : credits < 15 ? 1.15 : 1;

export function approvedClassCredits(state, owner, replacement = null) {
  return (state.classRecords || []).filter(row => row.owner === owner && !row.archived)
    .reduce((sum, row) => sum + Math.round((replacement?.classId === row.id ? replacement.credits : row.approvedCredits ?? 0) * 100), 0) / 100;
}

// A reviewed class is only part of a schedule. Only a separate Chair confirmation
// establishes the complete semester load used for point multipliers.
export function creditLoadView(state, owner) {
  const saved = state.creditLoads?.[owner];
  const approvedCredits = approvedClassCredits(state, owner);
  const confirmed = !!saved && validHours(saved.credits) && saved.credits >= approvedCredits;
  return { confirmed, credits: saved?.credits ?? null, approvedCredits,
    multiplier: confirmed ? creditMultiplier(saved.credits) : 1,
    needsReview: !!saved && !confirmed, reviewer: saved?.reviewer ?? null, at: saved?.at ?? null,
    version: JSON.stringify([state.semesterGeneration || 'initial', state.memberProfiles?.[owner]?.version || 'initial', saved?.version || 'initial']) };
}

export function refreshCreditLoadEstimates(state, owner = null) {
  const factors = new Map();
  for (const item of state.submissions || []) {
    if (item.status !== 'pending' || !Number.isFinite(item.base) || owner && item.owner !== owner) continue;
    if (!factors.has(item.owner)) factors.set(item.owner, creditLoadView(state, item.owner).multiplier);
    item.estimate = Math.round(item.base * factors.get(item.owner) * 100) / 100;
  }
  return state;
}

export function confirmCreditLoad(state, owner, input, { reviewer, at, newVersion }) {
  if (!input || Object.keys(input).sort().join(',') !== 'credits,version' || !validHours(input.credits))
    fail(422, 'Enter the full semester credit load from 0 to 30, with up to two decimal places.');
  const current = creditLoadView(state, owner);
  if (input.version !== current.version) fail(409, 'This member’s classes or credit load changed. Reload and confirm the current full schedule.');
  if (input.credits < current.approvedCredits)
    fail(422, `The full load cannot be below ${current.approvedCredits} approved class hours. Correct the class hours first.`);
  const record = { credits: input.credits, reviewer, at, version: newVersion() };
  state.creditLoads ||= {};
  state.creditLoads[owner] = record;
  state.creditLoadHistory ||= [];
  state.creditLoadHistory.push({ owner, before: current.credits, ...record });
  refreshCreditLoadEstimates(state, owner);
  return creditLoadView(state, owner);
}
