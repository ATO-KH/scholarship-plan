// Manual credits are separate from submissions and are never credit-load multiplied.
export function pointBreakdown(state, owner) {
  const submissionPoints = state.submissions.filter(item => item.owner === owner && item.status === "approved")
    .reduce((sum, item) => sum + item.awarded, 0);
  const adjustmentPoints = (state.pointAdjustments || []).filter(item => item.owner === owner)
    .reduce((sum, item) => sum + item.delta, 0);
  return { submissionPoints, adjustmentPoints, approved: submissionPoints + adjustmentPoints };
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
  if (!Number.isSafeInteger(input.total) || input.total < 0 || input.total > 10000)
    fail(422, "Enter a whole-point total from 0 to 10,000.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 1000) fail(422, "Add a reason of up to 1,000 characters. The member can see it.");
  const delta = input.total - view.approved;
  if (!delta) fail(422, "Enter a total different from the current approved points.");
  const item = { id, owner: member.id, delta, previousTotal: view.approved, total: input.total,
    reason, actor: actor.name, actorId: actor.id, at };
  state.pointAdjustments ||= [];
  state.pointAdjustments.push(item);
  return pointAdjustmentView(state, member);
}
