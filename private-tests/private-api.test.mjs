import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const running = [];
let demo;
let production;

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function start(mode = "demo", { missingOrigin = false } = {}) {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "ato-private-api-"));
  const base = `http://127.0.0.1:${port}`;
  const origin = mode === "demo" ? base : "https://portal.example.test";
  const env = {
    ...process.env,
    DATABASE_URL: "",
    VERCEL: "",
    VERCEL_ENV: "",
    SUPABASE_URL: "",
    SUPABASE_SECRET_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SUPABASE_STORAGE_BUCKET: "",
    ROSTER_REQUIRED: "",
    ROSTER_SHEET_ID: "",
    ROSTER_SHEET_RANGE: "",
    ROSTER_SERVICE_ACCOUNT_EMAIL: "",
    ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "",
    APP_MODE: mode,
    PORT: String(port),
    PUBLIC_ORIGIN: missingOrigin ? "" : origin,
    PRIVATE_DATA_DIR: directory,
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_HOSTED_DOMAIN: "",
    MICROSOFT_CLIENT_ID: "",
    MICROSOFT_CLIENT_SECRET: "",
    MICROSOFT_TENANT_ID: "",
    CANVAS_CLIENT_ID: "",
    CANVAS_CLIENT_SECRET: "",
    CANVAS_ORIGIN: "",
    CANVAS_BASE_URL: "",
  };
  const child = spawn(process.execPath, ["server/private.mjs"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = {
    child,
    directory,
    base,
    origin,
    output: "",
    errorOutput: "",
  };
  running.push(record);
  child.stdout.on("data", (chunk) => {
    record.output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    record.errorOutput += chunk;
  });
  if (missingOrigin) return record;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        finish(
          new Error(`Private server startup timed out: ${record.errorOutput}`),
        ),
      10_000,
    );
    const onData = () => {
      if (record.output.includes("ATO scholarship private:")) finish();
    };
    const onError = (error) => finish(error);
    const onExit = (code) =>
      finish(new Error(`Private server exited ${code}: ${record.errorOutput}`));
    function finish(error) {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    onData();
  });
  return record;
}

async function request(
  server,
  path,
  { body, headers = {}, method = body === undefined ? "GET" : "POST" } = {},
) {
  const response = await fetch(server.base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const isJSON = response.headers
    .get("content-type")
    ?.includes("application/json");
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    payload: isJSON ? JSON.parse(bytes.toString("utf8")) : null,
  };
}

function client(server = demo) {
  let cookie = "";
  let csrfToken = "";
  return {
    get cookie() {
      return cookie;
    },
    get csrfToken() {
      return csrfToken;
    },
    async send(path, body, extraHeaders = {}) {
      const result = await request(server, path, {
        body,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined
            ? {}
            : {
                Origin: server.origin,
                "X-ATO-Demo": "1",
                ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
              }),
          ...extraHeaders,
        },
      });
      const setCookie = result.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      if (result.payload?.csrfToken) csrfToken = result.payload.csrfToken;
      return {
        ...result.payload,
        status: result.status,
        headers: result.headers,
        bytes: result.bytes,
      };
    },
  };
}

const claim = {
  title: "Private API test quiz",
  course: "MTH 2002",
  activity: "major",
  grade: 95,
  date: "2026-09-28",
  evidence: "sample",
  confirm: true,
};
const pdf = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5cQAAAAASUVORK5CYII=",
  "base64",
);

before(async () => {
  demo = await start("demo");
  production = await start("production");
});

after(async () => {
  for (const record of running.reverse()) {
    if (record.child.exitCode === null && record.child.signalCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => record.child.kill("SIGKILL"), 3_000);
        record.child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        record.child.kill("SIGTERM");
      });
    }
    await rm(record.directory, { recursive: true, force: true });
  }
});

test("anonymous requests reveal configuration but no member data", async () => {
  assert.equal((await request(demo, "/api/config")).status, 200);
  for (const path of [
    "/api/session",
    "/api/submissions",
    "/api/points",
    "/api/members",
    "/api/audit",
    "/api/uploads/unknown",
  ]) {
    assert.equal((await request(demo, path)).status, 401, path);
  }
});

test("session bootstrap requires the exact origin and demo header; cookie is not script-readable", async () => {
  for (const headers of [
    {},
    { Origin: demo.origin },
    { "X-ATO-Demo": "1" },
    { Origin: "https://unrelated.example", "X-ATO-Demo": "1" },
    { Origin: `${demo.origin}.attacker.example`, "X-ATO-Demo": "1" },
  ]) {
    assert.equal(
      (await request(demo, "/api/demo/session", { body: {}, headers })).status,
      403,
    );
  }
  const c = client();
  const session = await c.send("/api/demo/session", {});
  assert.equal(session.status, 200);
  assert.equal(session.user.id, "alex");
  assert.equal(session.mode, "demo");
  assert.ok(c.csrfToken.length >= 32);
  assert.match(session.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(session.headers.get("set-cookie"), /SameSite=(Strict|Lax)/i);
  assert.match(session.headers.get("cache-control"), /no-store/);
});

test("member data access is scoped to identity, including direct foreign record and evidence URLs", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  const list = await c.send("/api/submissions");
  assert.equal(list.status, 200);
  assert.equal(list.submissions.length, 8);
  assert.ok(list.submissions.every((item) => item.owner === "alex"));
  for (const path of [
    "/api/submissions/S-2001",
    "/api/submissions/S-2001/evidence",
  ]) {
    assert.equal((await c.send(path)).status, 404, path);
  }
  assert.equal((await c.send("/api/members")).status, 403);
  assert.equal((await c.send("/api/roster")).status, 403);
  assert.equal((await c.send("/api/audit")).status, 403);
  assert.equal(
    (
      await c.send("/api/submissions/S-1008/review", {
        decision: "approved",
        points: 5,
      })
    ).status,
    403,
  );
  await c.send("/api/demo/session", { persona: "jordan" });
  const other = await c.send("/api/submissions");
  assert.ok(other.submissions.every((item) => item.owner === "jordan"));
  assert.equal((await c.send("/api/submissions/S-1008")).status, 404);
});

test("Chair tier import accepts only roster emails and tiers, then updates member goals", async () => {
  const isolated = await start("demo");
  const memberClient = client(isolated);
  await memberClient.send("/api/demo/session", {});
  assert.equal((await memberClient.send("/api/admin/tier-import")).status, 403);
  assert.equal((await memberClient.send("/api/admin/tier-import", {
    snapshot: "a".repeat(64), assignments: [{ email: "other@example.edu", tier: 1 }],
  })).status, 403);
  assert.equal((await memberClient.send("/api/admin/tier-import/settings", { mapping: {} })).status, 403);
  assert.equal((await memberClient.send("/api/roster/alex/academic-settings", { tier: 1, credits: 15 })).status, 403);

  const chairClient = client(isolated);
  await chairClient.send("/api/demo/session", { persona: "chair" });
  const preview = await chairClient.send("/api/admin/tier-import");
  assert.equal(preview.status, 200);
  assert.match(preview.snapshot, /^[a-f0-9]{64}$/);
  const mapping = { headerRow: 3, firstDataRow: 4, nameMode: "split",
    columns: { first: 3, last: 1, full: -1, schoolId: 2, gpa: 0, email: 4 } };
  assert.equal((await chairClient.send("/api/admin/tier-import/settings", {
    mapping: { ...mapping, gpa: "2.60" },
  })).status, 422);
  assert.equal((await chairClient.send("/api/admin/tier-import/settings", { mapping })).status, 200);
  const saved = await chairClient.send("/api/admin/tier-import");
  assert.deepEqual(saved.mapping, mapping);
  assert.equal(saved.snapshot, preview.snapshot);
  const target = preview.targets.find((entry) => entry.accountId && entry.currentTier !== 4);
  assert.ok(target);
  assert.equal((await chairClient.send("/api/admin/tier-import", {
    snapshot: preview.snapshot,
    assignments: [{ email: target.email, tier: 4, gpa: 2.6, schoolId: "900123456" }],
  })).status, 422);
  assert.equal((await chairClient.send("/api/admin/tier-import", {
    snapshot: preview.snapshot,
    assignments: [{ email: target.email, tier: 4 }, { email: "not-on-roster@example.edu", tier: 2 }],
  })).status, 422);
  assert.equal((await chairClient.send("/api/admin/tier-import")).snapshot, preview.snapshot);
  assert.equal((await chairClient.send("/api/admin/tier-import", {
    snapshot: preview.snapshot,
    assignments: [{ email: "not-on-roster@example.edu", tier: 4 }],
  })).status, 422);
  const applied = await chairClient.send("/api/admin/tier-import", {
    snapshot: preview.snapshot,
    assignments: [{ email: target.email, tier: 4 }],
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.updated, 1);
  assert.equal((await chairClient.send("/api/admin/tier-import", {
    snapshot: preview.snapshot,
    assignments: [{ email: target.email, tier: 3 }],
  })).status, 409);
  const roster = await chairClient.send("/api/roster");
  assert.equal(roster.members.find((entry) => entry.id === target.accountId).goal, 90);
  assert.equal((await chairClient.send(`/api/roster/${target.accountId}/academic-settings`, {
    tier: 3, credits: 12, gpa: "2.60",
  })).status, 422);
  const settings = await chairClient.send(`/api/roster/${target.accountId}/academic-settings`, {
    tier: 3, credits: 12,
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.member.goal, 70);
  assert.equal(settings.member.credits, 12);
  const audit = await chairClient.send("/api/audit");
  assert.equal(JSON.stringify(audit).includes("900123456"), false);
  assert.equal(JSON.stringify(audit).includes("2.6"), false);
});

test("shared FAQ is readable by members, editable only by Chair, and rejects stale changes", async () => {
  const isolated = await start("demo");
  const member = client(isolated);
  assert.equal((await member.send("/api/faq")).status, 401);
  await member.send("/api/demo/session", {});
  // Use the same demo workspace to demonstrate shared FAQ content across roles.
  const initial = await member.send("/api/faq");
  assert.equal(initial.entries.find((entry) => entry.id === "faq-noah").answer, "tbh idk");
  const change = { version: initial.version, operation: "upsert",
    entry: { id: null, question: "Who assigns my tier?", answer: "The Scholarship Chair.\nAsk before changing it." } };
  assert.equal((await member.send("/api/faq", change)).status, 403);
  await member.send("/api/demo/session", { persona: "chair" });
  const added = await member.send("/api/faq", change);
  assert.equal(added.status, 200);
  assert.notEqual(added.version, initial.version);
  const entry = added.entries.find((item) => item.question === change.entry.question);
  assert.ok(entry.id);
  assert.equal((await member.send("/api/faq", change)).status, 409);
  assert.equal((await member.send("/api/faq", { ...change, version: added.version,
    entry: { ...change.entry, question: " " },
  })).status, 422);
  const edited = await member.send("/api/faq", { version: added.version, operation: "upsert",
    entry: { ...entry, answer: "Chair assigns tiers after reviewing the import." } });
  assert.equal(edited.status, 200);
  await member.send("/api/demo/session", { persona: "alex" });
  const shared = await member.send("/api/faq");
  assert.equal(shared.entries.find((item) => item.id === entry.id).answer, "Chair assigns tiers after reviewing the import.");
  assert.equal((await member.send("/api/faq", { version: shared.version, operation: "delete", id: entry.id })).status, 403);
  await member.send("/api/demo/session", { persona: "chair" });
  const removed = await member.send("/api/faq", { version: shared.version, operation: "delete", id: entry.id });
  assert.equal(removed.status, 200);
  assert.equal(removed.entries.some((item) => item.id === entry.id), false);
});

test("mutation requires CSRF token and exact origin; switching persona invalidates the old token", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  const originalToken = c.csrfToken;
  const headers = { Cookie: c.cookie, Origin: demo.origin, "X-ATO-Demo": "1" };
  assert.equal(
    (await request(demo, "/api/submissions", { body: claim, headers })).status,
    403,
  );
  assert.equal(
    (
      await request(demo, "/api/submissions", {
        body: claim,
        headers: { ...headers, "X-CSRF-Token": "incorrect" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(demo, "/api/submissions", {
        body: claim,
        headers: {
          ...headers,
          "X-CSRF-Token": c.csrfToken,
          Origin: "https://unrelated.example",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(demo, "/api/submissions", {
        body: claim,
        headers: { Cookie: c.cookie, "X-CSRF-Token": c.csrfToken },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(demo, "/api/demo/session", {
        body: { persona: "chair" },
        headers,
      })
    ).status,
    403,
  );
  assert.equal(
    (await c.send("/api/demo/session", { persona: "chair" })).status,
    200,
  );
  assert.notEqual(c.csrfToken, originalToken);
  assert.equal(
    (
      await c.send(
        "/api/submissions/S-1008/review",
        { decision: "approved", points: 5 },
        { "X-CSRF-Token": originalToken },
      )
    ).status,
    403,
  );
});

test("submission stays pending until chair review and contributes points exactly once", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  assert.equal((await c.send("/api/points")).approved, 18);
  const created = await c.send("/api/submissions", {
    ...claim,
    owner: "jordan",
    awarded: 999,
    status: "approved",
  });
  assert.equal(created.status, 201);
  assert.equal(created.submission.owner, "alex");
  assert.equal(created.submission.status, "pending");
  assert.equal(created.submission.awarded, 0);
  assert.equal(created.points.approved, 18);
  await c.send("/api/demo/session", { persona: "chair" });
  const path = `/api/submissions/${created.submission.id}/review`;
  const approved = await c.send(path, {
    decision: "approved",
    points: 5,
    note: "",
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.points.approved, 23);
  assert.equal(
    (await c.send(path, { decision: "approved", points: 5 })).status,
    409,
  );
  const audit = await c.send("/api/audit");
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.events));
  assert.ok(JSON.stringify(audit.events).includes(created.submission.id));
  await c.send("/api/demo/session", { persona: "alex" });
  assert.equal((await c.send("/api/points")).approved, 23);
});

test("denial requires an explanation and contributes zero approved points", async () => {
  const c = client();
  await c.send("/api/demo/session", { persona: "chair" });
  assert.equal(
    (
      await c.send("/api/submissions/S-1008/review", {
        decision: "denied",
        note: "",
      })
    ).status,
    422,
  );
  const denied = await c.send("/api/submissions/S-1008/review", {
    decision: "denied",
    points: 999,
    note: "The fictional evidence does not show a grade.",
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.points.approved, 18);
  assert.equal(
    (
      await c.send("/api/submissions/S-1008/review", {
        decision: "approved",
        points: 5,
      })
    ).status,
    409,
  );
  await c.send("/api/demo/session", { persona: "alex" });
  const item = (await c.send("/api/submissions")).submissions.find(
    (item) => item.id === "S-1008",
  );
  assert.equal(item.status, "denied");
  assert.equal(item.awarded, 0);
  assert.match(item.reviewNote, /does not show a grade/);
});

test("fractional estimates require whole points and a chair explanation", async () => {
  const c = client();
  await c.send("/api/demo/session", { persona: "chair" });
  const path = "/api/submissions/S-2001/review";
  assert.equal(
    (
      await c.send(path, {
        decision: "approved",
        points: 5.75,
        note: "Explanation",
      })
    ).status,
    422,
  );
  assert.equal(
    (await c.send(path, { decision: "approved", points: 6, note: "" })).status,
    422,
  );
  assert.equal(
    (
      await c.send(path, {
        decision: "approved",
        points: 6,
        note: "Demonstration decision; chapter rounding rule is unresolved.",
      })
    ).status,
    200,
  );
});

test("claim validation rejects expired and duplicate work and enforces weekly study and minor-assignment caps", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  assert.equal(
    (await c.send("/api/submissions", { ...claim, date: "2026-09-13" })).status,
    422,
  );
  assert.equal((await c.send("/api/submissions", claim)).status, 201);
  assert.equal((await c.send("/api/submissions", claim)).status, 422);
  assert.equal(
    (
      await c.send("/api/submissions", {
        ...claim,
        title: "Overlong study",
        activity: "independent",
        quantity: 6,
      })
    ).status,
    422,
  );
  for (let count = 1; count <= 3; count++) {
    assert.equal(
      (
        await c.send("/api/submissions", {
          ...claim,
          activity: "minor",
          title: `Minor assignment ${count}`,
        })
      ).status,
      201,
    );
  }
  assert.equal(
    (
      await c.send("/api/submissions", {
        ...claim,
        activity: "minor",
        title: "Minor assignment four",
      })
    ).status,
    422,
  );
});

test("Canvas sample import stays pending, skips duplicates and rejects an invalid batch atomically", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  const list = await c.send("/api/integrations/canvas/assignments");
  assert.equal(list.status, 200);
  assert.equal(list.mode, "sample");
  assert.equal(list.providerConnected, false);
  assert.equal(list.assignments.length, 3);
  const selection = {
    items: [{ assignmentId: 2201, activity: "major" }],
    confirm: true,
  };
  const first = await c.send("/api/integrations/canvas/import", selection);
  assert.equal(first.status, 201);
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0].status, "pending");
  assert.equal(first.imported[0].owner, "alex");
  assert.equal(first.points.approved, 18);
  const repeated = await c.send("/api/integrations/canvas/import", selection);
  assert.equal(repeated.status, 201);
  assert.deepEqual(repeated.imported, []);
  assert.deepEqual(repeated.skippedDuplicateAssignmentIds, [2201]);
  const invalid = await c.send("/api/integrations/canvas/import", {
    items: [
      { assignmentId: 2202, activity: "lab" },
      { assignmentId: 2203, activity: "minor" },
    ],
    confirm: true,
  });
  assert.equal(invalid.status, 422);
  const submissions = (await c.send("/api/submissions")).submissions;
  assert.equal(submissions.length, 9);
  assert.equal(
    submissions.filter((item) => item.canvasAssignmentId === 2201).length,
    1,
  );
  assert.ok(
    submissions.every(
      (item) =>
        item.canvasAssignmentId !== 2202 && item.canvasAssignmentId !== 2203,
    ),
  );
});

test("independent demo browsers cannot observe one another's mutations or uploads", async () => {
  const a = client();
  const b = client();
  await a.send("/api/demo/session", {});
  await b.send("/api/demo/session", {});
  const created = await a.send("/api/submissions", claim);
  assert.equal(created.status, 201);
  assert.equal((await a.send("/api/submissions")).submissions.length, 9);
  assert.equal((await b.send("/api/submissions")).submissions.length, 8);
  const uploaded = await a.send("/api/uploads", {
    name: "proof.pdf",
    mime: "application/pdf",
    base64: pdf.toString("base64"),
  });
  assert.equal(uploaded.status, 201);
  assert.equal(
    (await b.send(`/api/uploads/${uploaded.upload.id}`)).status,
    404,
  );
  await b.send("/api/demo/session", { persona: "chair" });
  assert.equal(
    (await b.send(`/api/uploads/${uploaded.upload.id}`)).status,
    404,
  );
  assert.equal(
    (await b.send(`/api/submissions/${created.submission.id}`)).status,
    404,
  );
});

test("uploaded proof is an attachment visible only to its owner and their chair", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  for (const fixture of [
    { name: "evidence.pdf", mime: "application/pdf", bytes: pdf },
    { name: "evidence.png", mime: "image/png", bytes: png },
  ]) {
    const uploaded = await c.send("/api/uploads", {
      name: fixture.name,
      mime: fixture.mime,
      base64: fixture.bytes.toString("base64"),
    });
    assert.equal(uploaded.status, 201);
    assert.ok(uploaded.upload.id);
    const path = `/api/uploads/${uploaded.upload.id}`;
    const owner = await c.send(path);
    assert.equal(owner.status, 200);
    assert.match(owner.headers.get("content-disposition"), /^attachment;/i);
    assert.equal(owner.headers.get("x-content-type-options"), "nosniff");
    assert.match(owner.headers.get("cache-control"), /no-store/);
    assert.deepEqual(owner.bytes, fixture.bytes);
    await c.send("/api/demo/session", { persona: "jordan" });
    assert.equal((await c.send(path)).status, 404);
    await c.send("/api/demo/session", { persona: "chair" });
    const chair = await c.send(path);
    assert.equal(chair.status, 200);
    assert.deepEqual(chair.bytes, fixture.bytes);
    await c.send("/api/demo/session", { persona: "alex" });
  }
});

test("proof uploads reject forged file type, unsupported formats, malformed data and oversize files", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  for (const body of [
    {
      name: "fake.pdf",
      mime: "application/pdf",
      base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
    },
    { name: "wrong.png", mime: "image/png", base64: pdf.toString("base64") },
    {
      name: "page.html",
      mime: "text/html",
      base64: Buffer.from("<p>text</p>").toString("base64"),
    },
    { name: "bad.pdf", mime: "application/pdf", base64: "%%%%" },
    { name: "empty.pdf", mime: "application/pdf", base64: "" },
  ]) {
    assert.equal((await c.send("/api/uploads", body)).status, 422, body.name);
  }
  const atLimit = Buffer.alloc(5 * 1024 * 1024);
  pdf.copy(atLimit);
  const accepted = await c.send("/api/uploads", {
    name: "exact-limit.pdf",
    mime: "application/pdf",
    base64: atLimit.toString("base64"),
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.upload.size, atLimit.length);
  const downloaded = await c.send(`/api/uploads/${accepted.upload.id}`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.bytes, atLimit);
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  pdf.copy(oversized);
  assert.ok(
    [413, 422].includes(
      (
        await c.send("/api/uploads", {
          name: "oversize.pdf",
          mime: "application/pdf",
          base64: oversized.toString("base64"),
        })
      ).status,
    ),
  );
});

test("roster changes are chair-only, validate identifiers, and reject duplicate identity bindings", async () => {
  const c = client();
  await c.send("/api/demo/session", {});
  const member = {
    name: "Roster Test",
    email: "roster.test@example.edu",
    provider: "microsoft",
    subject: "12345678-1234-1234-1234-123456789abc:oid:bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    tier: 2,
    credits: 15,
  };
  assert.equal((await c.send("/api/roster", member)).status, 403);
  await c.send("/api/demo/session", { persona: "chair" });
  assert.equal((await c.send("/api/roster")).status, 200);
  for (const invalid of [
    { ...member, name: "" },
    { ...member, email: "not-an-email" },
    { ...member, provider: "arbitrary" },
    { ...member, provider: "google" },
    { ...member, subject: "" },
    { ...member, tier: 9 },
    { ...member, credits: -1 },
  ]) {
    assert.equal((await c.send("/api/roster", invalid)).status, 422);
  }
  const created = await c.send("/api/roster", member);
  assert.equal(created.status, 201);
  const duplicate = await c.send("/api/roster", {
    ...member,
    email: "renamed@example.edu",
  });
  assert.ok([409, 422].includes(duplicate.status));
  const roster = await c.send("/api/roster");
  assert.equal(roster.status, 200);
  const rosterById = new Map(roster.members.map((entry) => [entry.id, entry]));
  assert.equal(rosterById.get(created.member.id).email, member.email);
  assert.deepEqual(rosterById.get(created.member.id).identities, [
    { provider: member.provider, subject: member.subject },
  ]);
  assert.deepEqual(rosterById.get("alex").identities, []);
  assert.deepEqual(rosterById.get("jordan").identities, []);
  const progress = await c.send("/api/members");
  assert.equal(progress.status, 200);
  assert.deepEqual(
    progress.members.map((entry) => entry.id).sort(),
    ["alex", "jordan", created.member.id].sort(),
  );
  const addedProgress = progress.members.find((entry) => entry.id === created.member.id);
  assert.equal(addedProgress.goal, 55);
  assert.equal(addedProgress.checkpointDate, "2026-10-10");
  assert.equal(addedProgress.credits, 15);
});

test("production mode has no demo bypass, no sample public data, and rejects Google login", async () => {
  const config = await request(production, "/api/config");
  assert.equal(config.status, 200);
  assert.equal(config.payload.mode, "production");
  assert.ok(Array.isArray(config.payload.providers));
  assert.ok(
    config.payload.providers.every((provider) => provider.configured === false),
  );
  assert.ok(!JSON.stringify(config.payload).includes("Noah Knickerbocker"));
  assert.ok(!JSON.stringify(config.payload).includes("S-1008"));
  assert.equal((await request(production, "/api/session")).status, 401);
  assert.equal(
    (
      await request(production, "/api/demo/session", {
        body: {},
        headers: { Origin: production.origin, "X-ATO-Demo": "1" },
      })
    ).status,
    404,
  );
  assert.deepEqual(config.payload.providers.map((provider) => provider.id), []);
  assert.equal(config.payload.chapterAuth.enabled, true);
  assert.equal((await request(production, "/auth/google")).status, 404);
  assert.equal((await request(production, "/api/submissions")).status, 401);
  assert.equal((await request(production, "/api/members")).status, 401);
});

test("production refuses startup without an explicit public origin", async () => {
  const invalid = await start("production", { missingOrigin: true });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            "Production unexpectedly kept running without PUBLIC_ORIGIN",
          ),
        ),
      5_000,
    );
    invalid.child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    invalid.child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    if (invalid.child.exitCode !== null) {
      clearTimeout(timeout);
      resolve(invalid.child.exitCode);
    }
  });
  assert.notEqual(code, 0);
  assert.match(invalid.errorOutput, /PUBLIC_ORIGIN/);
});
