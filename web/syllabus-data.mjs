const fail = (message, status = 422) => { throw Object.assign(Error(message), { status }); };
export function classInput(input) {
  if (!input || typeof input.name !== "string") fail("Enter a class name or course code.");
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) fail("Class names must be between 1 and 80 characters.");
  return name;
}
export function syllabusView(state, item) {
  if (!item) return null;
  const course = (state.classRecords || []).find(row => row.id === item.classId && row.owner === item.owner);
  return { id: item.id, classId: item.classId, className: item.className, owner: item.owner,
    status: item.status, version: item.version, fileName: item.fileName, mime: item.mime,
    reviewNote: item.reviewNote || "", createdAt: item.createdAt, reviewedAt: item.reviewedAt || null,
    reviewer: item.reviewer || null, archived: !!course?.archived,
    current: !!course && course.syllabusId === item.id && !course.archived };
}
export function classView(state, owner) {
  const all = (state.classRecords || []).filter(row => row.owner === owner);
  const classes = all.filter(row => !row.archived).map(row => {
    const syllabus = (state.syllabi || []).find(item => item.id === row.syllabusId && item.owner === owner && item.classId === row.id);
    return { id: row.id, name: row.name, syllabusId: syllabus?.id || null, status: syllabus?.status || "missing",
      version: row.version, fileName: syllabus?.fileName || "", reviewNote: syllabus?.reviewNote || "" };
  });
  const known = new Set(all.map(row => row.name.toLowerCase()));
  for (const name of state.memberProfiles?.[owner]?.courses || []) if (!known.has(name.toLowerCase())) {
    classes.push({ id: null, name, syllabusId: null, status: "missing", version: state.memberProfiles?.[owner]?.version || "initial", fileName: "", reviewNote: "" });
  }
  return { classes, version: state.memberProfiles?.[owner]?.version || "initial" };
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
