import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let proc, temp;
const port = 4187,
  base = "http://127.0.0.1:" + port;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "ato-api-"));
  proc = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      ATO_DEMO_PORT: String(port),
      ATO_DEMO_DB: join(temp, "test.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      if (String(d).includes("ATO scholarship demo:")) resolve();
    });
    proc.once("error", reject);
    proc.once("exit", (c) => reject(Error("Server exited " + c)));
  });
});
after(async () => {
  proc?.kill();
  await new Promise((r) => proc?.once("exit", r));
  await rm(temp, { recursive: true, force: true });
});
function client() {
  let cookie;
  return async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-ATO-Demo": "1" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const payload = await response.json();
    return { status: response.status, ...payload };
  };
}
const claim = {
  title: "Test quiz",
  course: "MTH 2002",
  activity: "major",
  grade: 95,
  date: "2026-09-28",
  evidence: "sample",
  confirm: true,
};
test("requires a session; member sees only own records and cannot review", async () => {
  const c = client();
  assert.equal((await c("/api/submissions")).status, 401);
  await c("/api/demo/session", {});
  const list = await c("/api/submissions");
  assert.equal(list.submissions.length, 8);
  assert.ok(list.submissions.every((s) => s.owner === "alex"));
  assert.equal((await c("/api/submissions/S-2001")).status, 404);
  assert.equal((await c("/api/submissions/S-2001/evidence")).status, 404);
  assert.equal((await c("/api/members")).status, 403);
  assert.equal(
    (
      await c("/api/submissions/S-1008/review", {
        decision: "approved",
        points: 5,
      })
    ).status,
    403,
  );
});
test("submit -> approve changes derived total once; duplicate review rejected", async () => {
  const c = client();
  await c("/api/demo/session", {});
  assert.equal((await c("/api/points")).approved, 18);
  const made = await c("/api/submissions", claim);
  assert.equal(made.status, 201);
  assert.equal(made.points.approved, 18);
  await c("/api/demo/session", { persona: "chair" });
  const approved = await c(
    "/api/submissions/" + made.submission.id + "/review",
    { decision: "approved", points: 5, note: "" },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.points.approved, 23);
  assert.equal(
    (
      await c("/api/submissions/" + made.submission.id + "/review", {
        decision: "approved",
        points: 5,
      })
    ).status,
    409,
  );
  await c("/api/demo/session", { persona: "alex" });
  assert.equal((await c("/api/points")).approved, 23);
});
test("denial needs reason and no points are awarded", async () => {
  const c = client();
  await c("/api/demo/session", { persona: "chair" });
  assert.equal(
    (
      await c("/api/submissions/S-1008/review", {
        decision: "denied",
        note: "",
      })
    ).status,
    422,
  );
  const result = await c("/api/submissions/S-1008/review", {
    decision: "denied",
    note: "The fictional grade evidence needs clarification.",
  });
  assert.equal(result.status, 200);
  assert.equal(result.points.approved, 18);
});
test("fractional estimate needs whole point award and explicit explanation", async () => {
  const c = client();
  await c("/api/demo/session", { persona: "chair" });
  assert.equal(
    (
      await c("/api/submissions/S-2001/review", {
        decision: "approved",
        points: 5.75,
        note: "test",
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await c("/api/submissions/S-2001/review", {
        decision: "approved",
        points: 6,
        note: "",
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await c("/api/submissions/S-2001/review", {
        decision: "approved",
        points: 6,
        note: "Demo rounding decision only; policy is unresolved.",
      })
    ).status,
    200,
  );
});
test("separate demo sessions do not share mutations", async () => {
  const a = client(),
    b = client();
  await a("/api/demo/session", {});
  await b("/api/demo/session", {});
  await a("/api/submissions", claim);
  assert.equal((await a("/api/submissions")).submissions.length, 9);
  assert.equal((await b("/api/submissions")).submissions.length, 8);
});
test("rejects late claims, duplicate claims, and study cap overflow", async () => {
  const c = client();
  await c("/api/demo/session", {});
  assert.equal(
    (await c("/api/submissions", { ...claim, date: "2026-09-13" })).status,
    422,
  );
  assert.equal((await c("/api/submissions", claim)).status, 201);
  assert.equal((await c("/api/submissions", claim)).status, 422);
  assert.equal(
    (
      await c("/api/submissions", {
        ...claim,
        title: "Study",
        activity: "independent",
        quantity: 6,
      })
    ).status,
    422,
  );
});
test("Canvas sample import is pending and duplicate-safe; invalid batch is atomic", async () => {
  const c = client();
  await c("/api/demo/session", {});
  const list = await c("/api/integrations/canvas/assignments");
  assert.equal(list.mode, "sample");
  assert.equal(list.providerConnected, false);
  assert.equal(list.assignments.length, 3);
  const input = {
    items: [{ assignmentId: 2201, activity: "major" }],
    confirm: true,
  };
  const first = await c("/api/integrations/canvas/import", input);
  assert.equal(first.status, 201);
  assert.equal(first.imported[0].status, "pending");
  assert.equal(first.points.approved, 18);
  assert.equal(first.imported[0].estimate, 5);
  const second = await c("/api/integrations/canvas/import", input);
  assert.equal(second.imported.length, 0);
  assert.deepEqual(second.skippedDuplicateAssignmentIds, [2201]);
  const invalid = await c("/api/integrations/canvas/import", {
    items: [
      { assignmentId: 2202, activity: "lab" },
      { assignmentId: 2203, activity: "minor" },
    ],
    confirm: true,
  });
  assert.equal(invalid.status, 422);
  assert.equal((await c("/api/submissions")).submissions.length, 9);
});
test("CSRF header and cross-origin checks reject unrelated requests", async () => {
  let res = await fetch(base + "/api/demo/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 403);
  res = await fetch(base + "/api/demo/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ATO-Demo": "1",
      Origin: "https://example.com",
    },
    body: "{}",
  });
  assert.equal(res.status, 403);
});
test("stale persona header rejects writes after another tab switches identity", async () => {
  const c = client();
  await c("/api/demo/session", { persona: "alex" });
  const session = await fetch(base + "/api/demo/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ATO-Demo": "1" },
    body: "{}",
  });
  const cookie = session.headers.get("set-cookie").split(";")[0];
  await fetch(base + "/api/demo/session", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-ATO-Demo": "1",
    },
    body: JSON.stringify({ persona: "jordan" }),
  });
  const res = await fetch(base + "/api/submissions", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-ATO-Demo": "1",
      "X-ATO-Expected-User": "alex",
    },
    body: JSON.stringify(claim),
  });
  assert.equal(res.status, 409);
});
