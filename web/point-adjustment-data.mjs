// Manual credits are separate from submissions and are never credit-load multiplied.
export const roundPoints = value => Math.round(value * 100) / 100;
export const validPoints = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10000 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
export const sumPoints = values => values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
export function pointBreakdown(state, owner) {
  const submissionPoints = sumPoints(state.submissions.filter(item => item.owner === owner && item.status === "approved").map(item => item.awarded));
  const adjustmentPoints = sumPoints((state.pointAdjustments || []).filter(item => item.owner === owner).map(item => item.delta));
  return { submissionPoints, adjustmentPoints, approved: roundPoints(submissionPoints + adjustmentPoints) };
}
export function pointAdjustmentView(state, member) {
  const history = (state.pointAdjustments || []).filter(item => item.owner === member.id);
  const points = pointBreakdown(state, member.id);
  return { member: { id: member.id, name: member.name }, ...points,
    version: `${state.semesterGeneration || "initial"}:${points.submissionPoints}:${history.length}:${history.at(-1)?.id || "none"}`,
    history: [...history].reverse().map(item => ({ ...item })) };
}
export function applyPointAdjustment(state, member, input, actor, id, at) {
  const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
  const view = pointAdjustmentView(state, member);
  if (!input || input.version !== view.version)
    fail(409, "This member’s points changed. Reopen the adjustment and review the current total.");
  if (!validPoints(input.total))
    fail(422, "Enter a point total from 0 to 10,000, with up to two decimal places.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 1000) fail(422, "Add a reason of up to 1,000 characters. The member can see it.");
  const delta = roundPoints(input.total - view.approved);
  if (!delta) fail(422, "Enter a total different from the current approved points.");
  const item = { id, owner: member.id, delta, previousTotal: view.approved, total: input.total,
    reason, actor: actor.name, actorId: actor.id, at };
  state.pointAdjustments ||= [];
  state.pointAdjustments.push(item);
  return pointAdjustmentView(state, member);
}
