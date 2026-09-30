export function profileView(state, id) {
  const profile = state.memberProfiles?.[id];
  return { courses: profile?.courses || [], version: profile?.version || "initial" };
}
export function validateCourses(input) {
  const fail = (message) => { throw Object.assign(Error(message), { status: 422 }); };
  if (!input || Object.keys(input).some(key => !["courses", "version"].includes(key)) ||
      !Array.isArray(input.courses) || input.courses.length > 20)
    fail("Provide up to 20 classes.");
  const courses = input.courses.map(course => {
    if (typeof course !== "string") fail("Each class needs a name or course code.");
    const value = course.trim().replace(/\s+/g, " ");
    if (!value || value.length > 80) fail("Class names must be between 1 and 80 characters.");
    return value;
  });
  if (new Set(courses.map(course => course.toLowerCase())).size !== courses.length)
    fail("Each class should appear only once.");
  return courses;
}
