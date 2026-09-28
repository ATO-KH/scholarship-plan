// Fictional Canvas-shaped responses. This module never contacts a university.
export const canvasAssignments = [
  {
    id: 2201,
    course_id: 101,
    name: "Calculus II · Quiz 4",
    course: "MTH 2002",
    points_possible: 20,
    grading_type: "points",
    submission: {
      score: 19,
      grade: "19",
      graded_at: "2026-09-27T16:00:00Z",
      workflow_state: "graded",
      posted_at: "2026-09-27T16:05:00Z",
      excused: false,
    },
  },
  {
    id: 2202,
    course_id: 102,
    name: "Physics · Lab report 3",
    course: "PHY 1001",
    points_possible: 50,
    grading_type: "points",
    submission: {
      score: 46,
      grade: "46",
      graded_at: "2026-09-25T16:00:00Z",
      workflow_state: "graded",
      posted_at: "2026-09-25T16:05:00Z",
      excused: false,
    },
  },
  {
    id: 2203,
    course_id: 103,
    name: "Programming · Project 2",
    course: "CSE 1001",
    points_possible: 100,
    grading_type: "points",
    submission: {
      score: 87,
      grade: "87",
      graded_at: "2026-09-26T16:00:00Z",
      workflow_state: "graded",
      posted_at: "2026-09-26T16:05:00Z",
      excused: false,
    },
  },
];
export function sampleAssignments(state, owner) {
  return canvasAssignments.map((a) => ({
    ...a,
    percent: Math.round((a.submission.score / a.points_possible) * 10000) / 100,
    imported: state.submissions.some(
      (s) =>
        s.owner === owner &&
        s.canvasCourseId === a.course_id &&
        s.canvasAssignmentId === a.id &&
        s.status !== "denied",
    ),
  }));
}
