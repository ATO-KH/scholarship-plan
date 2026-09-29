// GitHub Pages demonstration only. Requests are simulated in this browser.
// IndexedDB contains fictional data; this is not a secure multi-user backend.
import {
  TODAY,
  members,
  activities,
  multiplier,
  seed,
  totals,
  validateClaim,
} from "./demo-domain.mjs";
import { canvasAssignments, sampleAssignments } from "./demo-canvas.mjs";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
const scope = new URL(self.registration.scope).pathname;
let queue = Promise.resolve();
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(scope + "api/")
  )
    return;
  const task = queue.then(() =>
    handle(event.request, "/" + url.pathname.slice(scope.length)),
  );
  queue = task.catch(() => {});
  event.respondWith(task);
});
function database() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ato-scholarship-pages-v1", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("demo");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function read() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("demo", "readonly"),
      r = tx.objectStore("demo").get("session");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => db.close();
  });
}
async function save(session) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("demo", "readwrite");
    tx.objectStore("demo").put(session, "session");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
const json = (data, status = 200) =>
  new Response(JSON.stringify({ mode: "browser-demo", ...data }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
async function handle(req, path) {
  try {
    if (!["GET", "POST"].includes(req.method)) fail(405, "Method not allowed.");
    const input = req.method === "POST" ? await req.json() : null;
    let session = await read();
    if (session && session.expires < Date.now()) session = null;
    if (path === "/api/demo/session" && req.method === "POST") {
      if (input.persona && !members.some((m) => m.id === input.persona))
        fail(400, "Unknown demo persona.");
      if (!session)
        session = {
          persona: input.persona || "alex",
          expires: Date.now() + 86400000,
          data: seed(),
        };
      else if (input.persona) session.persona = input.persona;
      await save(session);
      return json({
        user: members.find((m) => m.id === session.persona),
        today: TODAY,
      });
    }
    if (!session) fail(401, "Start a demo session first.");
    if (
      req.headers.get("X-ATO-Expected-User") &&
      req.headers.get("X-ATO-Expected-User") !== session.persona
    )
      fail(
        409,
        "The demo account changed in another tab. Refresh before continuing.",
      );
    const state = session.data,
      user = members.find((m) => m.id === session.persona);
    const chair = () => {
      if (user.role !== "chair")
        fail(403, "Only the Scholarship Chair can review submissions.");
    };
    const own = (id) => {
      const s = state.submissions.find((s) => s.id === id);
      if (!s || (user.role !== "chair" && s.owner !== user.id))
        fail(404, "Submission not found.");
      return s;
    };
    if (path === "/api/me" && req.method === "GET")
      return json({ user, today: TODAY });
    if (path === "/api/rules" && req.method === "GET")
      return json({
        activities,
        today: TODAY,
        submissionWindowDays: 14,
        weeklyStudyHours: 5,
        weeklyMinorAssignments: 3,
        weekConvention: "Monday–Sunday (demo assumption)",
        checkpoints: [
          { date: "2026-09-12", targets: [10, 14, 18, 23, 30] },
          { date: "2026-10-10", targets: [20, 28, 36, 46, 60] },
          { date: "2026-11-06", targets: [30, 42, 54, 70, 90] },
          { date: "2026-12-04", targets: [40, 55, 70, 90, 120] },
        ],
      });
    if (path === "/api/points" && req.method === "GET") {
      if (user.role !== "member")
        fail(400, "Choose a member view for individual points.");
      return json({ member: user.id, ...totals(state, user) });
    }
    if (path === "/api/members" && req.method === "GET") {
      chair();
      return json({
        members: members
          .filter((m) => m.role === "member")
          .map((m) => ({ ...m, ...totals(state, m) })),
      });
    }
    if (path === "/api/submissions" && req.method === "GET")
      return json({
        submissions: state.submissions
          .filter((s) => user.role === "chair" || s.owner === user.id)
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
          .map((s) => ({
            ...s,
            memberName: members.find((m) => m.id === s.owner).name,
          })),
      });
    const make = (claim) => ({
      ...claim,
      id: "S-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
      owner: user.id,
      status: "pending",
      awarded: 0,
      submittedAt: new Date().toISOString(),
      reviewNote: "",
      history: [
        { event: "Submitted for review", at: new Date().toISOString() },
      ],
    });
    if (path === "/api/submissions" && req.method === "POST") {
      if (user.role !== "member") fail(403, "Use a member account to submit.");
      let claim;
      try {
        claim = validateClaim(input, state, user);
      } catch (e) {
        fail(422, e.message);
      }
      const item = make(claim);
      state.submissions.push(item);
      await save(session);
      return json({ submission: item, points: totals(state, user) }, 201);
    }
    if (
      path === "/api/integrations/canvas/assignments" &&
      req.method === "GET"
    ) {
      if (user.role !== "member")
        fail(403, "Canvas imports belong to the member.");
      return json({
        providerConnected: false,
        assignments: sampleAssignments(state, user.id),
        note: "Fictional Canvas-shaped data; no Canvas request was made.",
      });
    }
    if (path === "/api/integrations/canvas/import" && req.method === "POST") {
      if (user.role !== "member") fail(403, "Use a member account.");
      if (
        input.confirm !== true ||
        !Array.isArray(input.items) ||
        input.items.length < 1 ||
        input.items.length > 10
      )
        fail(422, "Select assignments and confirm the categories.");
      const added = [],
        skipped = [];
      for (const selected of input.items) {
        const a = canvasAssignments.find((a) => a.id === selected.assignmentId);
        if (!a) fail(422, "Unknown sample assignment.");
        if (!["major", "minor", "lab"].includes(selected.activity))
          fail(422, "Choose major, minor, or lab.");
        if (
          state.submissions.some(
            (s) =>
              s.owner === user.id &&
              s.canvasCourseId === a.course_id &&
              s.canvasAssignmentId === a.id &&
              s.status !== "denied",
          )
        ) {
          skipped.push(a.id);
          continue;
        }
        let claim;
        try {
          claim = validateClaim(
            {
              title: a.name,
              course: a.course,
              date: a.submission.graded_at.slice(0, 10),
              activity: selected.activity,
              grade: (a.submission.score / a.points_possible) * 100,
              evidence: "sample",
              confirm: true,
              note: "Imported from fictional Canvas sample. Chair must verify classification.",
            },
            state,
            user,
          );
        } catch (e) {
          fail(422, a.name + ": " + e.message);
        }
        const item = {
          ...make(claim),
          source: "canvas-sample",
          canvasCourseId: a.course_id,
          canvasAssignmentId: a.id,
        };
        state.submissions.push(item);
        added.push(item);
      }
      await save(session);
      return json(
        {
          imported: added,
          skippedDuplicateAssignmentIds: skipped,
          points: totals(state, user),
        },
        201,
      );
    }
    const route = path.match(
      /^\/api\/submissions\/([^/]+)(?:\/(review|evidence))?$/,
    );
    if (route) {
      const item = own(route[1]);
      if (!route[2] && req.method === "GET")
        return json({
          submission: {
            ...item,
            memberName: members.find((m) => m.id === item.owner).name,
          },
        });
      if (route[2] === "evidence" && req.method === "GET")
        return json({
          evidence: {
            sample: true,
            submission: item.id,
            title: item.title,
            activity: activities.find((a) => a.id === item.activity).name,
            course: item.course,
            date: item.date,
            grade: item.grade,
            hours: item.quantity,
            note: item.note,
            verification:
              "Fictional sample record; no real academic documentation was uploaded.",
          },
        });
      if (route[2] === "review" && req.method === "POST") {
        chair();
        if (item.status !== "pending")
          fail(409, "This submission has already been reviewed.");
        if (!["approved", "denied"].includes(input.decision))
          fail(422, "Choose approve or deny.");
        const note = String(input.note || "").trim(),
          points = input.points;
        if (note.length > 1000)
          fail(422, "Review note must be under 1,000 characters.");
        if (
          input.decision === "approved" &&
          (!Number.isInteger(points) || points < 0 || points > 100)
        )
          fail(422, "Award a whole number from 0 to 100.");
        if (
          (input.decision === "denied" || points !== item.estimate) &&
          note.length < 5
        )
          fail(422, "Explain the denial or point adjustment.");
        item.status = input.decision;
        item.awarded = input.decision === "approved" ? points : 0;
        item.reviewNote = note;
        item.reviewer = user.name;
        item.reviewedAt = new Date().toISOString();
        item.history.push({
          event:
            input.decision === "approved"
              ? `Approved · ${points} points`
              : "Denied",
          by: user.name,
          at: item.reviewedAt,
          note,
        });
        await save(session);
        return json({
          submission: item,
          points: totals(
            state,
            members.find((m) => m.id === item.owner),
          ),
        });
      }
    }
    if (path === "/api/demo/reset" && req.method === "POST") {
      session.data = seed();
      await save(session);
      return json({ reset: true });
    }
    if (path === "/api/export" && req.method === "GET") {
      chair();
      const q = (v) =>
        '"' +
        String(/^[=+@\-\t\r]/.test(String(v)) ? "'" + v : (v ?? "")).replaceAll(
          '"',
          '""',
        ) +
        '"';
      const lines = [
        [
          "Submission",
          "Member",
          "Activity",
          "Title",
          "Date",
          "Status",
          "Approved points",
          "Review note",
        ],
        ...state.submissions.map((s) => [
          s.id,
          members.find((m) => m.id === s.owner).name,
          s.activity,
          s.title,
          s.date,
          s.status,
          s.awarded,
          s.reviewNote,
        ]),
      ];
      return new Response(lines.map((r) => r.map(q).join(",")).join("\r\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    }
    fail(404, "Demo API endpoint not found.");
  } catch (e) {
    return json(
      {
        error: e.status
          ? e.message
          : "Browser demo storage is unavailable. Enable site storage and reload.",
      },
      e.status || 500,
    );
  }
}
