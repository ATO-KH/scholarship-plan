export const TODAY = "2026-09-28";
export const members = [
  {
    id: "test1",
    name: "Test Member",
    initials: "T1",
    email: "test1@example.edu",
    role: "member",
    tier: 2,
    credits: 15,
    gpa: "3.24",
    goal: 55,
    checkpoint: 28,
  },
  {
    id: "alex",
    name: "Noah Knickerbocker",
    initials: "NK",
    email: "noah.knickerbocker@example.edu",
    role: "member",
    tier: 2,
    credits: 15,
    gpa: "3.24",
    goal: 55,
    checkpoint: 28,
  },
  {
    id: "jordan",
    name: "Jordan Ellis",
    initials: "JE",
    email: "jordan.ellis@example.edu",
    role: "member",
    tier: 1,
    credits: 12,
    gpa: "3.68",
    goal: 40,
    checkpoint: 20,
  },
  {
    id: "chair",
    name: "Taylor Morgan",
    initials: "TM",
    email: "scholarship.chair@example.edu",
    role: "chair",
  },
];
export const activities = [
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
      "A sample screenshot showing a grade of at least 90%. Maximum three minor assignments per week.",
    grade: true,
  },
  {
    id: "lab",
    name: "Lab report",
    points: "2",
    unit: "report",
    proof: "A sample grade screenshot showing at least 90%.",
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
export const multiplier = (m) =>
  m.credits < 9 ? 1.5 : m.credits < 12 ? 1.3 : m.credits < 15 ? 1.15 : 1;
export const weekOf = (date) => {
  let d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
export function score(data) {
  let a = activities.find((x) => x.id === data.activity);
  if (!a) throw Error("Choose a listed activity.");
  let grade = Number(data.grade),
    quantity = Number(data.quantity ?? 1);
  if (a.hours && (!Number.isFinite(quantity) || quantity <= 0 || quantity > 24))
    throw Error("Hours must be greater than 0 and no more than 24.");
  if (a.grade && (!Number.isFinite(grade) || grade < 0 || grade > 100))
    throw Error("Enter a grade from 0 to 100.");
  let base =
    a.id === "major"
      ? grade >= 95
        ? 5
        : grade >= 90
          ? 4
          : grade >= 85
            ? 3
            : grade >= 80
              ? 2
              : 0
      : a.grade
        ? grade >= 90
          ? 2
          : 0
        : Number(a.points) * (a.hours ? quantity : 1);
  if (base <= 0) throw Error("This grade does not earn points under the plan.");
  return {
    base,
    quantity: a.hours ? quantity : 1,
    grade: a.grade ? grade : null,
  };
}
export function seed() {
  const make = (
    id,
    owner,
    activity,
    title,
    course,
    date,
    status,
    base,
    quantity = 1,
    note = "",
  ) => ({
    id,
    owner,
    activity,
    title,
    course,
    date,
    submittedAt: date + "T17:00:00.000Z",
    status,
    base,
    quantity,
    grade:
      activity === "major"
        ? base === 5
          ? 97
          : 94
        : activity === "minor" || activity === "lab"
          ? 95
          : null,
    estimate: base * multiplier(members.find((x) => x.id === owner)),
    awarded: status === "approved" ? base : 0,
    evidence: "sample",
    note: "Fictional demonstration evidence.",
    reviewNote: note,
    history: [
      { event: "Submitted for review", at: date + "T17:00:00.000Z" },
      ...(status === "pending"
        ? []
        : [
            {
              event:
                status === "approved" ? `Approved · ${base} points` : "Denied",
              by: "Taylor Morgan",
              at: date + "T18:00:00.000Z",
              note,
            },
          ]),
    ],
  });
  return {
    submissions: [
      make(
        "S-1008",
        "alex",
        "major",
        "Calculus II · Midterm 1",
        "MTH 2002",
        "2026-09-26",
        "pending",
        5,
        1,
      ),
      make(
        "S-1007",
        "alex",
        "office",
        "Physics office hours",
        "PHY 1001",
        "2026-09-25",
        "pending",
        2,
        1,
      ),
      make(
        "S-1006",
        "alex",
        "minor",
        "Programming · Problem set 3",
        "CSE 1001",
        "2026-09-23",
        "denied",
        2,
        1,
        "Please include a grade screenshot. The sample submitted does not show a grade.",
      ),
      make(
        "S-1005",
        "alex",
        "lab",
        "Physics · Lab report 2",
        "PHY 1001",
        "2026-09-22",
        "approved",
        2,
      ),
      make(
        "S-1004",
        "alex",
        "tutoring",
        "Calculus SI session",
        "MTH 2002",
        "2026-09-21",
        "approved",
        3,
      ),
      make(
        "S-1003",
        "alex",
        "major",
        "Programming · Project 1",
        "CSE 1001",
        "2026-09-18",
        "approved",
        4,
      ),
      make(
        "S-1002",
        "alex",
        "group",
        "Calculus group study",
        "MTH 2002",
        "2026-09-16",
        "approved",
        4,
        2,
      ),
      make(
        "S-1001",
        "alex",
        "meeting",
        "Semester scholarship check-in",
        "Scholarship",
        "2026-09-15",
        "approved",
        5,
      ),
      make(
        "S-2001",
        "jordan",
        "major",
        "Chemistry · Exam 1",
        "CHM 1101",
        "2026-09-27",
        "pending",
        5,
      ),
      make(
        "S-2002",
        "jordan",
        "independent",
        "Hub independent study",
        "CHM 1101",
        "2026-09-24",
        "pending",
        2,
        2,
      ),
    ],
  };
}
export function totals(state, member) {
  const mine = state.submissions.filter((s) => s.owner === member.id);
  return {
    approved: mine
      .filter((s) => s.status === "approved")
      .reduce((n, s) => n + s.awarded, 0),
    pending: mine.filter((s) => s.status === "pending").length,
    pendingEstimate: mine
      .filter((s) => s.status === "pending")
      .reduce((n, s) => n + s.estimate, 0),
    approvedCount: mine.filter((s) => s.status === "approved").length,
    denied: mine.filter((s) => s.status === "denied").length,
    goal: member.goal,
    checkpoint: member.checkpoint,
    multiplier: multiplier(member),
    studyHours: mine
      .filter(
        (s) =>
          activities.find((a) => a.id === s.activity)?.study &&
          s.status !== "denied" &&
          weekOf(s.date) === weekOf(TODAY),
      )
      .reduce((n, s) => n + s.quantity, 0),
  };
}
export function validateClaim(body, state, member) {
  const activity = activities.find((x) => x.id === body.activity);
  const title = String(body.title || "").trim(),
    course = String(body.course || "").trim();
  if (!title || title.length > 120 || !course || course.length > 80)
    throw Error(
      "Add an activity title (up to 120 characters) and course (up to 80).",
    );
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ||
    isNaN(Date.parse(body.date)) ||
    new Date(body.date).toISOString().slice(0, 10) !== body.date
  )
    throw Error("Enter a valid activity date.");
  const age = (Date.parse(TODAY) - Date.parse(body.date)) / 86400000;
  if (age < 0 || age > 14)
    throw Error(
      "The demo accepts activities within 14 days of September 28, 2026.",
    );
  if (body.evidence !== "sample")
    throw Error("Attach the fictional sample evidence.");
  if (body.confirm !== true)
    throw Error("Confirm this activity has not already been claimed.");
  const value = score(body);
  const existing = state.submissions.filter(
    (s) => s.owner === member.id && s.status !== "denied",
  );
  if (
    existing.some(
      (s) =>
        s.date === body.date &&
        s.title.toLowerCase() === title.toLowerCase() &&
        s.course.toLowerCase() === course.toLowerCase(),
    )
  )
    throw Error("This activity already has a submission.");
  const week = existing.filter((s) => weekOf(s.date) === weekOf(body.date));
  if (
    activity.study &&
    week
      .filter((s) => activities.find((a) => a.id === s.activity)?.study)
      .reduce((n, s) => n + s.quantity, 0) +
      value.quantity >
      5
  )
    throw Error(
      "This would exceed five study hours for the week. Pending claims reserve hours in this demo.",
    );
  if (
    activity.id === "minor" &&
    week.filter((s) => s.activity === "minor").length >= 3
  )
    throw Error("Three minor assignments are already claimed this week.");
  return {
    ...value,
    activity: body.activity,
    title,
    course,
    date: body.date,
    evidence: "sample",
    note: String(body.note || "")
      .trim()
      .slice(0, 1000),
    estimate: Math.round(value.base * multiplier(member) * 100) / 100,
  };
}
