import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CATEGORIES, categoriesFor, categoryView, categoryForSubmission, validateCategory, applyCategoryChange, scoreCategory } from "../web/category-data.mjs";
import { validateClaim, totals, members, seed } from "../server/domain.mjs";

const fixed = (overrides = {}) => ({ name: "Research presentation", unit: "presentation", proof: "Provide the program and dated attendance confirmation.", enabled: true,
  mode: "fixed", rate: 8, minGrade: 0, bands: [], study: false, weeklyLimit: null, ...overrides });
const claim = { activity: "major", title: "Unique test", course: "MTH 2002", date: "2026-09-28", grade: 95, evidence: "sample", confirm: true };

test("default category scores preserve all original plan bands, thresholds and hourly rates", () => {
  const major = DEFAULT_CATEGORIES.find(item => item.id === "major");
  for (const [grade, expected] of [[80, 2], [84.99, 2], [85, 3], [90, 4], [95, 5], [100, 5]])
    assert.equal(scoreCategory(major, { grade }).base, expected);
  assert.throws(() => scoreCategory(major, { grade: 79.99 }), /does not earn/);
  for (const id of ["minor", "lab"]) {
    const category = DEFAULT_CATEGORIES.find(item => item.id === id);
    assert.throws(() => scoreCategory(category, { grade: 89 }), /does not earn/);
    assert.equal(scoreCategory(category, { grade: 90 }).base, 2);
  }
  assert.equal(scoreCategory(DEFAULT_CATEGORIES.find(item => item.id === "office"), { quantity: 1.5 }).base, 3);
  const changed = categoriesFor(); changed[0].bands[0].points = 45;
  assert.equal(DEFAULT_CATEGORIES[0].bands[0].points, 2);
});

test("configurable category validation bounds inputs and supports each score mode", () => {
  assert.equal(scoreCategory(validateCategory(fixed()), {}).base, 8);
  assert.equal(scoreCategory(validateCategory(fixed({ mode: "hourly", rate: 50 })), { quantity: 24 }).base, 1200);
  const grade = validateCategory(fixed({ mode: "grade", minGrade: 75 }));
  assert.equal(scoreCategory(grade, { grade: 75 }).base, 8);
  assert.throws(() => scoreCategory(grade, { grade: 74 }), /does not earn/);
  const bands = validateCategory(fixed({ mode: "bands", bands: [{ minGrade: 65, points: 1 }, { minGrade: 90, points: 7 }] }));
  assert.equal(scoreCategory(bands, { grade: 88 }).base, 1);
  assert.equal(scoreCategory(bands, { grade: 90 }).base, 7);
  assert.equal(bands.points, "1–7");
  assert.equal(bands.grade, true);
  for (const override of [{ name: "" }, { proof: "x".repeat(1201) }, { rate: 51 }, { rate: 1.5 }, { weeklyLimit: 0 }, { study: true }, { enabled: "true" }, { mode: "eval" }, { minGrade: NaN }, { bands: "" }, { id: "../../" }, { mode: "bands", bands: [{ minGrade: 90, points: 3 }, { minGrade: 80, points: 2 }] }])
    assert.throws(() => validateCategory(fixed(override)), error => error.status === 422);
  assert.throws(() => scoreCategory(grade, { grade: "" }), /Enter a grade/);
  assert.throws(() => scoreCategory(validateCategory(fixed({ mode: "hourly" })), { quantity: Infinity }), /Hours/);
});

test("category changes preserve claim snapshots, points, default isolation, stable ids and stale protection", () => {
  const state = seed(), before = structuredClone(state.submissions);
  const original = categoryView(state), major = original.categories[0];
  const changed = applyCategoryChange(state, { version: original.version, category: { ...major, name: "Renamed major", rate: 40,
    bands: [{ minGrade: 80, points: 20 }], proof: "Different requirements.", enabled: false } });
  assert.notEqual(changed.version, original.version);
  assert.equal(changed.categories[0].id, major.id);
  assert.equal(categoryForSubmission(state, state.submissions[0]).name, "Major assignment");
  assert.equal(categoryForSubmission(state, state.submissions[0]).bands[0].points, 2);
  assert.deepEqual(state.submissions.map(({ activitySnapshot, ...rest }) => rest), before);
  assert.throws(() => validateClaim(claim, state, members[0]), /available/);
  assert.throws(() => applyCategoryChange(state, { version: original.version, category: major }), error => error.status === 409);
  assert.throws(() => applyCategoryChange(state, { version: changed.version, category: fixed({ name: "renamed MAJOR" }) }), /already uses/);
  assert.throws(() => applyCategoryChange(state, { version: changed.version, category: fixed({ id: "not-real" }) }), error => error.status === 404);
  assert.equal(categoriesFor()[0].name, "Major assignment");
  assert.throws(() => validateClaim({ ...claim, categoryVersion: original.version }, state, members[0]), error => error.status === 409);
  const created = applyCategoryChange(state, { version: changed.version, category: fixed() }, () => "activity-new");
  assert.equal(created.categories.at(-1).id, "activity-new");
  assert.equal(validateClaim({ ...claim, activity: "activity-new" }, state, members[0]).base, 8);
  assert.notEqual(categoryView({ ...state, semesterGeneration: "new-semester" }).version, created.version);
});

test("weekly limits use stable category ids and historical study flags survive rule edits", () => {
  const state = { submissions: [] }, category = { ...categoriesFor().find(item => item.id === "group"), weeklyLimit: 1 };
  applyCategoryChange(state, { version: categoryView(state).version, category });
  const first = validateClaim({ ...claim, activity: "group", quantity: 4 }, state, members[0]);
  state.submissions.push({ ...first, owner: "alex", status: "pending" });
  assert.equal(first.activitySnapshot.study, true);
  assert.throws(() => validateClaim({ ...claim, title: "Another group", activity: "group", quantity: 1 }, state, members[0]), /1 claims/);
  applyCategoryChange(state, { version: categoryView(state).version, category: { ...category, study: false } });
  assert.equal(totals(state, members[0]).studyHours, 4);
  assert.throws(() => validateClaim({ ...claim, title: "Independent hours", activity: "independent", quantity: 2 }, state, members[0]), /five study hours/);
});
