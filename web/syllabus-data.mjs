import { approvedClassCredits, creditLoadView } from './credit-load-data.mjs';
export { approvedClassCredits } from './credit-load-data.mjs';
const fail = (message, status = 422) => { throw Object.assign(Error(message), { status }); };
export function classInput(input) {
  if (!input || typeof input.name !== "string") fail("Enter a class name or course code.");
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) fail("Class names must be between 1 and 80 characters.");
  return name;
}
export function classCredits(input) {
  const value = input?.credits;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 30 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8)
    fail("Enter this class's credit hours from 0 to 30, with at most two decimal places.");
  return value;
}
export const creditsManaged = (state, owner) => state.classCreditsManaged?.[owner] === true;
export function approveClassCredits(state, course, credits) {
  classCredits({ credits });
  const total = approvedClassCredits(state, course.owner, { classId: course.id, credits });
  if (total > 30) fail("These classes would exceed 30 approved credit hours. Correct the class hours before approval.");
  course.approvedCredits = credits;
  state.classCreditsManaged ||= {};
  state.classCreditsManaged[course.owner] = true;
  return total;
}
export function refreshPendingCreditEstimates(state, owner, factor) {
  for (const item of state.submissions || []) if (item.owner === owner && item.status === "pending" && Number.isFinite(item.base))
    item.estimate = Math.round(item.base * factor * 100) / 100;
}
// One decision path for the live portal and its fictional demonstration.
// Corrections replace the current award; they never add a second set of hours.
export function applySyllabusDecision(state, syllabus, course, input, { correction = false, reviewer, at, newVersion }) {
  if (!syllabus || !course || course.archived || course.syllabusId !== syllabus.id || course.pendingRemoval ||
      syllabus.version !== input.version || (correction ? !['approved', 'denied'].includes(syllabus.status) : syllabus.status !== 'pending'))
    fail('This class changed or was already reviewed. Reload its current details.', 409);
  if (!['approved', 'denied'].includes(input.decision)) fail('Choose approve or deny.');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  const credits = input.credits === undefined ? syllabus.credits : classCredits(input);
  const changedHours = credits !== syllabus.credits;
  if (note.length > 1000 || ((correction || changedHours || input.decision === 'denied') && note.length < 5))
    fail('Explain the correction, changed hours, or denial in a note of 5–1,000 characters.');
  if (input.decision === 'denied' && changedHours) fail('Approve the class to change its credit hours.');
  const before = { status: syllabus.status, credits: syllabus.credits ?? null, approvedCredits: course.approvedCredits ?? null,
    note: syllabus.reviewNote || '', reviewer: syllabus.reviewer || null, at: syllabus.reviewedAt || null };
  let total = null;
  if (input.decision === 'approved') total = approveClassCredits(state, course, credits);
  else if (correction && syllabus.status === 'approved') {
    course.approvedCredits = null;
    state.classCreditsManaged ||= {};
    state.classCreditsManaged[course.owner] = true;
    total = approvedClassCredits(state, course.owner);
  }
  if (changedHours) syllabus.submittedCredits ??= syllabus.credits;
  Object.assign(syllabus, { status: input.decision, credits, reviewNote: note, reviewer, reviewedAt: at, version: newVersion() });
  syllabus.history ||= [];
  syllabus.history.push({ correction, before, status: syllabus.status, credits, approvedCredits: course.approvedCredits ?? null, note, reviewer, at });
  course.version = newVersion();
  state.memberProfiles ||= {};
  (state.memberProfiles[course.owner] ||= { courses: [] }).version = newVersion();
  return { total };
}
export function applySyllabusBatch(state, input, options) {
  if (!input || Object.keys(input).join(',') !== 'approvals' || !Array.isArray(input.approvals) || !input.approvals.length || input.approvals.length > 20)
    throw Object.assign(Error('Select between 1 and 20 classes to approve together.'), { status: 422 });
  const draft = structuredClone(state), owners = new Map(), seen = new Set();
  for (const approval of input.approvals) {
    if (!approval || Object.keys(approval).sort().join(',') !== 'credits,id,note,version' || typeof approval.id !== 'string' || seen.has(approval.id))
      throw Object.assign(Error('Each approval must include one unique class, its version, hours, and note.'), { status: 422 });
    seen.add(approval.id);
    const syllabus = draft.syllabi?.find(row => row.id === approval.id);
    const course = draft.classRecords?.find(row => row.id === syllabus?.classId && row.owner === syllabus.owner);
    if (!syllabus || !course) throw Object.assign(Error('A selected class changed. Reload the list before approving.'), { status: 409 });
    const { total } = applySyllabusDecision(draft, syllabus, course, { ...approval, decision: 'approved' }, options);
    owners.set(course.owner, total);
  }
  // Validate every decision before exposing any changes, including in the
  // browser demo. A stale class or excessive total cannot partially approve.
  Object.assign(state, draft);
  return { owners, ids: [...seen] };
}

export function ownerClassReviews(state, owner, accountCredits, memberName) {
  return { owner, creditLoad: creditLoadView(state, owner),
    syllabi: (state.syllabi || []).filter(row => row.owner === owner).map(row => ({ ...syllabusView(state, row, accountCredits), memberName })).filter(row => row.current),
    removals: (state.classRecords || []).filter(row => row.owner === owner && !row.archived && row.pendingRemoval)
      .map(row => ({ ...removalView(state, row, accountCredits), memberName })) };
}
export function removalView(state, course, accountCredits) {
  return { classId: course.id, className: course.name, owner: course.owner, creditLoad: creditLoadView(state, course.owner),
    version: course.pendingRemoval.version, credits: course.approvedCredits, status: "pending",
    currentAccountCredits: creditsManaged(state, course.owner) ? accountCredits : null,
    projectedAccountCredits: approvedClassCredits(state, course.owner, { classId: course.id, credits: 0 }) };
}
export function syllabusView(state, item, accountCredits = null) {
  if (!item) return null;
  const course = (state.classRecords || []).find(row => row.id === item.classId && row.owner === item.owner);
  return { id: item.id, classId: item.classId, className: item.className, owner: item.owner, creditLoad: creditLoadView(state, item.owner),
    status: item.status, version: item.version, credits: item.credits ?? null,
    approvedCredits: course?.approvedCredits ?? null, removalPending: !!course?.pendingRemoval,
    currentAccountCredits: creditsManaged(state, item.owner) ? accountCredits : null, approvedAccountCredits: approvedClassCredits(state, item.owner),
    projectedAccountCredits: item.credits == null ? null : approvedClassCredits(state, item.owner, { classId: item.classId, credits: item.credits }), fileName: item.fileName, mime: item.mime,
    reviewNote: item.reviewNote || "", createdAt: item.createdAt, reviewedAt: item.reviewedAt || null,
    reviewer: item.reviewer || null, history: item.history || [], archived: !!course?.archived,
    current: !!course && course.syllabusId === item.id && !course.archived };
}
export function classView(state, owner, accountCredits = null) {
  const all = (state.classRecords || []).filter(row => row.owner === owner);
  const classes = all.filter(row => !row.archived).map(row => {
    const syllabus = (state.syllabi || []).find(item => item.id === row.syllabusId && item.owner === owner && item.classId === row.id);
    return { id: row.id, name: row.name, syllabusId: syllabus?.id || null, status: syllabus?.status || "missing",
      credits: syllabus?.credits ?? null, approvedCredits: row.approvedCredits ?? null,
      removalPending: !!row.pendingRemoval, removalVersion: row.pendingRemoval?.version ?? null, removalReview: row.removalReview || null,
      version: row.version, fileName: syllabus?.fileName || "", reviewNote: syllabus?.reviewNote || "" };
  });
  const known = new Set(all.map(row => row.name.toLowerCase()));
  for (const name of state.memberProfiles?.[owner]?.courses || []) if (!known.has(name.toLowerCase())) {
    classes.push({ id: null, name, credits: null, approvedCredits: null, removalPending: false, removalVersion: null, syllabusId: null, status: "missing", version: state.memberProfiles?.[owner]?.version || "initial", fileName: "", reviewNote: "" });
  }
  return { classes, creditLoad: creditLoadView(state, owner), approvedCredits: approvedClassCredits(state, owner), accountCredits, creditsManaged: creditsManaged(state, owner), version: state.memberProfiles?.[owner]?.version || "initial" };
}
export function assignmentClass(state, owner, activity, input) {
  if (!activity?.grade) return {};
  const course = (state.classRecords || []).find(row => row.id === input.classId && row.owner === owner && !row.archived);
  if (!course) fail("Choose a class with an approved syllabus. Add your class and syllabus in My profile first.");
  const syllabus = (state.syllabi || []).find(row => row.id === course.syllabusId && row.classId === course.id && row.owner === owner);
  if (syllabus?.status !== "approved") fail("The Scholarship Chair must approve this class syllabus before you submit assignments.");
  return { classId: course.id, syllabusId: syllabus.id, course: course.name };
}
export function submissionSyllabus(state, submission) {
  if (!submission.syllabusId) return null;
  const item = (state.syllabi || []).find(row => row.id === submission.syllabusId && row.classId === submission.classId && row.owner === submission.owner);
  return syllabusView(state, item);
}
