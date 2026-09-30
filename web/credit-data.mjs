const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export function validateCreditRequest(input, requests, owner) {
  if (!Number.isFinite(input?.credits) || input.credits < 0 || input.credits > 30)
    fail(422, "Enter credit hours between 0 and 30.");
  if (requests.some(item => item.owner === owner && item.status === "pending"))
    fail(409, "You already have a credit-hours request awaiting review.");
}
export function validateCreditReview(input, item, currentCredits) {
  if (!item) fail(404, "Credit-hours request not found.");
  if (item.status !== "pending") fail(409, "This request has already been reviewed.");
  if (!["approved", "denied"].includes(input?.decision)) fail(422, "Choose approve or deny.");
  if (typeof input.note !== "string" || input.note.length > 1000 || (input.decision === "denied" && input.note.trim().length < 5))
    fail(422, "Add a reason for a denial (5–1,000 characters).");
  if (input.decision === "approved" && currentCredits !== item.previousCredits)
    fail(409, "This member’s hours changed after submission. Deny this outdated request and ask for a new one.");
}
export function creditSummary(item) {
  const { image, evidenceId, ...summary } = item;
  return summary;
}
