const initialCategories = [
  {
    id: "major",
    name: "Major assignment",
    points: "2–5",
    unit: "assignment",
    proof:
      "A sample screenshot of the assignment grade. Individual weight is generally more than 5% of the course.",
    grade: true,
  },
  {
    id: "minor",
    name: "Minor assignment",
    points: "2",
    unit: "assignment",
    proof:
      "A sample screenshot of the assignment grade.",
    grade: true,
  },
  {
    id: "lab",
    name: "Lab report",
    points: "2",
    unit: "report",
    proof: "A sample screenshot of the report grade.",
    grade: true,
  },
  {
    id: "office",
    name: "Professor office hours",
    points: "2",
    unit: "hour",
    proof: "Dated confirmation with the professor’s signature.",
    hours: true,
  },
  {
    id: "tutoring",
    name: "SSSC tutoring / SI session",
    points: "3",
    unit: "session",
    proof:
      "Tutor signature and date, or online check-in plus booking confirmation.",
  },
  {
    id: "partner",
    name: "Study with a brother",
    points: "2",
    unit: "hour",
    proof:
      "Partner signature, date, and hours. Partner GPA must be at least 3.00; chair follow-up is required.",
    hours: true,
    study: true,
  },
  {
    id: "group",
    name: "ATO group study",
    points: "2",
    unit: "hour",
    proof:
      "At least three active brothers studying the same subject, with credible attendance proof.",
    hours: true,
    study: true,
  },
  {
    id: "independent",
    name: "Independent study",
    points: "1",
    unit: "hour",
    proof: "A Florida Tech Hub study-hours log.",
    hours: true,
    study: true,
  },
  {
    id: "night",
    name: "Study night",
    points: "2",
    unit: "hour",
    proof: "Sign-in and sign-out records, with each timestamp to the minute.",
    hours: true,
    study: true,
  },
  {
    id: "meeting",
    name: "Semester scholarship meeting",
    points: "5",
    unit: "meeting",
    proof:
      "Dated signature from the Scholarship Chair or Director of Student Success and Support.",
  },
  {
    id: "calendar",
    name: "Complete academic calendar",
    points: "5",
    unit: "calendar",
    proof: "A Google Calendar with classes, office hours, and major due dates.",
  },
 ];

// Canonical rules are shared by the server and isolated browser demonstration.
const clone = (value) => structuredClone(value);
const initial = initialCategories.map(category => ({
  ...category,
  enabled: true,
  mode: category.id === "major" ? "bands" : category.grade ? "grade" : category.hours ? "hourly" : "fixed",
  rate: category.id === "major" ? 2 : Number(category.points),
  minGrade: category.grade ? (category.id === "major" ? 80 : 90) : 0,
  bands: category.id === "major" ? [80, 85, 90, 95].map((minGrade, index) => ({ minGrade, points: index + 2 })) : [],
  study: category.study === true,
  weeklyLimit: category.id === "minor" ? 3 : null,
}));
const fail = (message, status = 422) => { throw Object.assign(Error(message), { status }); };
const plain = value => value && typeof value === "object" && !Array.isArray(value);
function display(category) {
  const copy = clone(category);
  copy.grade = ["grade", "bands"].includes(copy.mode);
  copy.hours = copy.mode === "hourly";
  copy.points = copy.mode === "bands" ? (() => {
    const values = copy.bands.map(band => band.points), low = Math.min(...values), high = Math.max(...values);
    return low === high ? String(low) : `${low}–${high}`;
  })() : String(copy.rate);
  return copy;
}
function freeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === "object") freeze(item);
  return Object.freeze(value);
}
export const DEFAULT_CATEGORIES = freeze(initial.map(display));
export const categoriesFor = (state = {}) => (state.pointCategories ?? DEFAULT_CATEGORIES).map(display);
export const categoryView = (state = {}) => ({ categories: categoriesFor(state),
  version: `${state.semesterGeneration || "initial"}:${state.pointCategoryRevision || 0}` });
export const categoryForSubmission = (state, submission) => clone(submission.activitySnapshot ??
  categoriesFor(state).find(category => category.id === submission.activity) ?? null);

export function validateCategory(input) {
  const keys = ["id", "name", "unit", "proof", "enabled", "mode", "rate", "minGrade", "bands", "study", "weeklyLimit", "points", "grade", "hours"];
  if (!plain(input) || Object.keys(input).some(key => !keys.includes(key))) fail("Submit a complete point category.");
  const text = (key, limit) => {
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].trim().length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input[key]))
      fail(`Enter a ${key} of at most ${limit} characters.`);
    return input[key].trim();
  };
  const name = text("name", 80), unit = text("unit", 40), proof = text("proof", 1200);
  if (input.id != null && (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.id))) fail("Invalid category identifier.");
  if (typeof input.enabled !== "boolean" || typeof input.study !== "boolean") fail("Set the category availability and study-hours setting.");
  if (!["fixed", "hourly", "grade", "bands"].includes(input.mode)) fail("Choose a supported point calculation.");
  if (!Number.isInteger(input.rate) || input.rate < 1 || input.rate > 50) fail("Points must be a whole number from 1 to 50.");
  if (typeof input.minGrade !== "number" || !Number.isFinite(input.minGrade) || input.minGrade < 0 || input.minGrade > 100) fail("Grade cutoffs must be from 0 to 100.");
  if (!Array.isArray(input.bands) || input.bands.length > 10 || (input.mode === "bands" && !input.bands.length)) fail("Set between one and ten grade bands.");
  const bands = input.bands.map((band, index) => {
    if (!plain(band) || Object.keys(band).sort().join(",") !== "minGrade,points" ||
        typeof band.minGrade !== "number" || !Number.isFinite(band.minGrade) || band.minGrade < 0 || band.minGrade > 100 ||
        !Number.isInteger(band.points) || band.points < 1 || band.points > 50 ||
        (index > 0 && (band.minGrade <= input.bands[index - 1].minGrade || band.points < input.bands[index - 1].points)))
      fail("Grade bands must have increasing cutoffs and nondecreasing whole points from 1 to 50.");
    return { minGrade: band.minGrade, points: band.points };
  });
  if (input.study && input.mode !== "hourly") fail("Only hourly categories can count toward the weekly study-hours limit.");
  if (input.weeklyLimit !== null && (!Number.isInteger(input.weeklyLimit) || input.weeklyLimit < 1 || input.weeklyLimit > 100))
    fail("The weekly claim limit must be from 1 to 100, or blank for no limit.");
  return display({ ...(input.id == null ? {} : { id: input.id }), name, unit, proof,
    enabled: input.enabled, mode: input.mode, rate: input.rate, minGrade: input.minGrade,
    bands, study: input.study, weeklyLimit: input.weeklyLimit });
}

export function applyCategoryChange(state, input, idFactory = () => `activity-${crypto.randomUUID()}`) {
  if (!plain(input) || Object.keys(input).sort().join(",") !== "category,version" || typeof input.version !== "string")
    fail("Submit the point category and its current version.");
  if (input.version !== categoryView(state).version) fail("The point categories or semester changed. Reload them before saving.", 409);
  const category = validateCategory(input.category), categories = categoriesFor(state);
  const index = category.id == null ? -1 : categories.findIndex(item => item.id === category.id);
  if (category.id != null && index < 0) fail("This point category no longer exists.", 404);
  if (categories.some(item => item.id !== category.id && item.name.toLowerCase() === category.name.toLowerCase()))
    fail("Another category already uses that name.");
  if (index < 0 && categories.length >= 100) fail("A maximum of 100 categories is supported. Reuse or disable an existing category.");
  if (index < 0) category.id = idFactory();
  if (typeof category.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(category.id) || (index < 0 && categories.some(item => item.id === category.id)))
    fail("Could not assign a new category identifier. Retry saving.", 503);
  // Capture the rules in force for old claims before changing any category.
  for (const submission of state.submissions || []) {
    if (!submission.activitySnapshot) {
      const previous = categories.find(item => item.id === submission.activity);
      if (previous) submission.activitySnapshot = clone(previous);
    }
  }
  if (index < 0) categories.push(category); else categories[index] = category;
  state.pointCategories = categories;
  state.pointCategoryRevision = (state.pointCategoryRevision || 0) + 1;
  return categoryView(state);
}

export function scoreCategory(category, data) {
  if (!category || !category.enabled) fail("Choose an available activity.");
  const grade = Number(data.grade), quantity = Number(data.quantity ?? 1);
  const hours = category.mode === "hourly", graded = ["grade", "bands"].includes(category.mode);
  if (hours && (!Number.isFinite(quantity) || quantity <= 0 || quantity > 24)) fail("Hours must be greater than 0 and no more than 24.");
  if (graded && (data.grade == null || data.grade === "" || !Number.isFinite(grade) || grade < 0 || grade > 100)) fail("Enter a grade from 0 to 100.");
  let base = category.rate * (hours ? quantity : 1);
  if (category.mode === "grade") base = grade >= category.minGrade ? category.rate : 0;
  if (category.mode === "bands") base = category.bands.reduce((points, band) => grade >= band.minGrade ? band.points : points, 0);
  if (base <= 0) fail("This grade does not earn points under the current category rules.");
  return { base: Math.round(base * 100) / 100, quantity: hours ? quantity : 1, grade: graded ? grade : null };
}
