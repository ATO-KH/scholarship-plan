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
export function approvedClassCredits(state, owner, replacement = null) {
  const total = (state.classRecords || []).filter(row => row.owner === owner && !row.archived)
    .reduce((sum, row) => sum + Math.round((replacement?.classId === row.id ? replacement.credits : row.approvedCredits ?? 0) * 100), 0) / 100;
  return total;
}
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
export function removalView(state, course, accountCredits) {
  return { classId: course.id, className: course.name, owner: course.owner,
    version: course.pendingRemoval.version, credits: course.approvedCredits, status: "pending",
    currentAccountCredits: accountCredits,
    projectedAccountCredits: approvedClassCredits(state, course.owner, { classId: course.id, credits: 0 }) };
}
export function syllabusView(state, item, accountCredits = null) {
  if (!item) return null;
  const course = (state.classRecords || []).find(row => row.id === item.classId && row.owner === item.owner);
  return { id: item.id, classId: item.classId, className: item.className, owner: item.owner,
    status: item.status, version: item.version, credits: item.credits ?? null,
    approvedCredits: course?.approvedCredits ?? null, removalPending: !!course?.pendingRemoval,
    currentAccountCredits: accountCredits,
    projectedAccountCredits: item.credits == null ? null : approvedClassCredits(state, item.owner, { classId: item.classId, credits: item.credits }), fileName: item.fileName, mime: item.mime,
    reviewNote: item.reviewNote || "", createdAt: item.createdAt, reviewedAt: item.reviewedAt || null,
    reviewer: item.reviewer || null, archived: !!course?.archived,
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
  return { classes, approvedCredits: approvedClassCredits(state, owner), accountCredits, creditsManaged: creditsManaged(state, owner), version: state.memberProfiles?.[owner]?.version || "initial" };
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
