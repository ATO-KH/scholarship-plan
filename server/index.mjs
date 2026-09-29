import http from "node:http";
import { canvasAssignments, sampleAssignments } from "./canvas-sample.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  TODAY,
  members,
  activities,
  multiplier,
  seed,
  totals,
  validateClaim,
} from "./domain.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "data"), { recursive: true });
const db = new DatabaseSync(
  process.env.ATO_DEMO_DB || resolve(root, "data/demo.sqlite"),
);
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, persona TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);",
);
const port = Number(process.env.ATO_DEMO_PORT || 4173);
function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 20000)
      throw Object.assign(Error("Request too large."), { status: 413 });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw Object.assign(Error("Invalid JSON."), { status: 400 });
  }
}
const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    const path = url.pathname;
    if (!path.startsWith("/api/")) {
      const mapping = {
        "/": "index.html",
        "/index.html": "index.html",
        "/style.css": "style.css",
        "/app.js": "app.js",
      };
      if (!mapping[path]) return json(res, 404, { error: "Not found" });
      const data = await readFile(resolve(root, "web", mapping[path]));
      res.writeHead(200, {
        "Content-Type": {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css",
          ".js": "text/javascript",
        }[extname(mapping[path])],
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
      });
      return res.end(data);
    }
    if (!["GET", "POST"].includes(req.method))
      return json(res, 405, { error: "Method not allowed" });
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (
        origin &&
        origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}`
      )
        return json(res, 403, { error: "Cross-origin request rejected." });
      if (req.headers["x-ato-demo"] !== "1")
        return json(res, 403, { error: "Demo request header required." });
    }
    const match = (req.headers.cookie || "").match(
      /(?:^|; )ato_demo=([a-f0-9]{64})(?:;|$)/,
    );
    let session = match
      ? db
          .prepare("SELECT * FROM sessions WHERE id = ? AND expires > ?")
          .get(match[1], Date.now())
      : null;
    if (path === "/api/demo/session" && req.method === "POST") {
      const data = await body(req);
      if (data.persona && !members.some((m) => m.id === data.persona))
        return json(res, 400, { error: "Unknown demo persona." });
      if (!session) {
        db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
        session = {
          id: randomBytes(32).toString("hex"),
          persona: data.persona || "alex",
          data: JSON.stringify(seed()),
          expires: Date.now() + 86400000,
        };
        db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(
          session.id,
          session.persona,
          session.data,
          session.expires,
        );
      } else if (data.persona) {
        session.persona = data.persona;
        db.prepare("UPDATE sessions SET persona=? WHERE id=?").run(
          session.persona,
          session.id,
        );
      }
      return json(
        res,
        200,
        {
          user: members.find((m) => m.id === session.persona),
          mode: "demo",
          today: TODAY,
        },
        {
          "Set-Cookie": `ato_demo=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        },
      );
    }
    if (!session)
      return json(res, 401, { error: "Start a demo session first." });
    // Parse mutating requests before reading current state, so two submissions cannot overwrite each other.
    const input = req.method === "POST" ? await body(req) : null;
    session = db
      .prepare("SELECT * FROM sessions WHERE id=? AND expires>?")
      .get(session.id, Date.now());
    if (!session) return json(res, 401, { error: "Demo session expired." });
    if (
      req.headers["x-ato-expected-user"] &&
      req.headers["x-ato-expected-user"] !== session.persona
    )
      fail(
        409,
        "The demo account changed in another tab. Refresh before continuing.",
      );
    let state = JSON.parse(session.data);
    const user = members.find((m) => m.id === session.persona);
    const chair = () => {
      if (user.role !== "chair")
        fail(403, "Only the Scholarship Chair can review submissions.");
    };
    const save = () =>
      db
        .prepare("UPDATE sessions SET data=? WHERE id=?")
        .run(JSON.stringify(state), session.id);
    const own = (id) => {
      const item = state.submissions.find((s) => s.id === id);
      if (!item || !(user.role === "chair" || item.owner === user.id))
        fail(404, "Submission not found.");
      return item;
    };
    if (path === "/api/me" && req.method === "GET")
      return json(res, 200, { user, mode: "demo", today: TODAY });
    if (path === "/api/rules" && req.method === "GET")
      return json(res, 200, {
        activities,
        today: TODAY,
        submissionWindowDays: 14,
        weeklyStudyHours: 5,
        weeklyMinorAssignments: 3,
        weekConvention: "Monday–Sunday (demo assumption)",
        rounding: "Chair must enter whole points and explain any difference.",
        tierSource: "Chair-assigned; GPA tier boundaries in the plan conflict.",
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
      return json(res, 200, { member: user.id, ...totals(state, user) });
    }
    if (path === "/api/members" && req.method === "GET") {
      chair();
      return json(res, 200, {
        members: members
          .filter((m) => m.role === "member")
          .map((m) => ({ ...m, ...totals(state, m) })),
      });
    }
    if (
      path === "/api/integrations/canvas/assignments" &&
      req.method === "GET"
    ) {
      if (user.role !== "member")
        fail(403, "Canvas imports belong to the signed-in member.");
      return json(res, 200, {
        mode: "sample",
        providerConnected: false,
        assignments: sampleAssignments(state, user.id),
        note: "Fictional Canvas-shaped data. No university API has been contacted.",
      });
    }
    if (path === "/api/integrations/canvas/import" && req.method === "POST") {
      if (user.role !== "member")
        fail(403, "Use a member account to import assignments.");
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
        if (!a) fail(422, "Unknown sample Canvas assignment.");
        if (!["major", "minor", "lab"].includes(selected.activity))
          fail(
            422,
            "Choose major assignment, minor assignment, or lab report.",
          );
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
              note: "Imported from fictional Canvas sample. Member classification requires chair verification.",
            },
            state,
            user,
          );
        } catch (e) {
          fail(422, a.name + ": " + e.message);
        }
        const item = {
          ...claim,
          id: "S-" + randomUUID().slice(0, 8).toUpperCase(),
          owner: user.id,
          status: "pending",
          awarded: 0,
          submittedAt: new Date().toISOString(),
          reviewNote: "",
          source: "canvas-sample",
          canvasCourseId: a.course_id,
          canvasAssignmentId: a.id,
          history: [
            {
              event: "Imported from Canvas sample and submitted for review",
              at: new Date().toISOString(),
            },
          ],
        };
        state.submissions.push(item);
        added.push(item);
      }
      save();
      return json(res, 201, {
        mode: "sample",
        imported: added,
        skippedDuplicateAssignmentIds: skipped,
        points: totals(state, user),
      });
    }
    if (path === "/api/submissions" && req.method === "GET") {
      let items = state.submissions.filter(
        (s) => user.role === "chair" || s.owner === user.id,
      );
      return json(res, 200, {
        submissions: items
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
          .map((s) => ({
            ...s,
            memberName: members.find((m) => m.id === s.owner).name,
          })),
      });
    }
    if (path === "/api/submissions" && req.method === "POST") {
      if (user.role !== "member")
        fail(403, "Use a member demo account to submit.");
      let claim;
      try {
        claim = validateClaim(input, state, user);
      } catch (e) {
        fail(422, e.message);
      }
      const item = {
        ...claim,
        id: "S-" + randomUUID().slice(0, 8).toUpperCase(),
        owner: user.id,
        status: "pending",
        awarded: 0,
        submittedAt: new Date().toISOString(),
        reviewNote: "",
        history: [
          { event: "Submitted for review", at: new Date().toISOString() },
        ],
      };
      state.submissions.push(item);
      save();
      return json(res, 201, { submission: item, points: totals(state, user) });
    }
    let route = path.match(
      /^\/api\/submissions\/([^/]+)(?:\/(review|evidence))?$/,
    );
    if (route) {
      const item = own(route[1]);
      if (!route[2] && req.method === "GET")
        return json(res, 200, {
          submission: {
            ...item,
            memberName: members.find((m) => m.id === item.owner).name,
          },
        });
      if (route[2] === "evidence" && req.method === "GET")
        return json(res, 200, {
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
              "Fictional sample record; no real academic documentation has been uploaded.",
          },
        });
      if (route[2] === "review" && req.method === "POST") {
        chair();
        if (item.status !== "pending")
          fail(409, "This submission has already been reviewed.");
        if (!["approved", "denied"].includes(input.decision))
          fail(422, "Choose approve or deny.");
        const note = String(input.note || "").trim();
        if (note.length > 1000)
          fail(422, "Keep the review note under 1,000 characters.");
        const points = input.points;
        if (
          input.decision === "approved" &&
          (!Number.isInteger(points) || points < 0 || points > 100)
        )
          fail(422, "Award a whole number of points from 0 to 100.");
        if (
          (input.decision === "denied" || points !== item.estimate) &&
          note.length < 5
        )
          fail(422, "Explain the denial or point adjustment in a review note.");
        item.status = input.decision;
        item.awarded = input.decision === "approved" ? points : 0;
        item.reviewNote = note;
        item.reviewedAt = new Date().toISOString();
        item.reviewer = user.name;
        item.history.push({
          event:
            input.decision === "approved"
              ? `Approved · ${points} points`
              : "Denied",
          by: user.name,
          at: item.reviewedAt,
          note,
        });
        save();
        return json(res, 200, {
          submission: item,
          points: totals(
            state,
            members.find((m) => m.id === item.owner),
          ),
        });
      }
    }
    if (path === "/api/demo/reset" && req.method === "POST") {
      state = seed();
      save();
      return json(res, 200, { reset: true });
    }
    if (path === "/api/export" && req.method === "GET") {
      chair();
      const q = (s) => '"' + String(s ?? "").replaceAll('"', '""') + '"';
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
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition":
          'attachment; filename="ato-demo-submissions.csv"',
      });
      return res.end(
        lines
          .map((r) =>
            r
              .map((v) => q(/^[=+@\-\t\r]/.test(String(v)) ? "'" + v : v))
              .join(","),
          )
          .join("\r\n"),
      );
    }
    return json(res, 404, { error: "API endpoint not found." });
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent)
      json(res, error.status || 500, {
        error: error.status
          ? error.message
          : "The demo service could not complete the request.",
      });
    else res.end();
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`ATO scholarship demo: http://127.0.0.1:${port}`),
);
