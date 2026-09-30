import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rosterStatus } from "../server/roster.mjs";

const project = resolve(import.meta.dirname, "..");
const semester = {
  name: "New semester",
  startDate: "2026-09-01",
  checkpointDates: ["2026-09-10", "2026-10-01", "2026-11-01"],
  targetDate: "2026-12-01",
  endDate: "2026-12-15",
};

async function portal(t, extra = {}) {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "ato-semester-api-"));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH || "",
    APP_MODE: "demo",
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    APP_DATA_DIR: directory,
    ...extra,
  };
  const child = spawn(process.execPath, ["server/private.mjs"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += data;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exit;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error(`Server did not start: ${errors}`)),
      10000,
    );
    child.stdout.on("data", (data) => {
      if (String(data).includes("ATO scholarship private:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Server exited ${code}: ${errors}`));
    });
  });
  let cookie = "",
    csrf = "";
  const api = async (path, body, { headers = {} } = {}) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        ...(body === undefined
          ? {}
          : {
              origin,
              "content-type": "application/json",
              "x-csrf-token": csrf,
            }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const value = await response.json();
    if (value.csrfToken) csrf = value.csrfToken;
    return { status: response.status, value };
  };
  const switchTo = async (persona) => {
    const result = await api(
      "/api/demo/session",
      { persona },
      { headers: { "x-ato-demo": "1" } },
    );
    assert.equal(result.status, 200);
    return result.value;
  };
  const editState = (update) => {
    const db = new DatabaseSync(join(directory, "demo", "chapter.sqlite"));
    try {
      const row = db
        .prepare(
          "SELECT workspace,data FROM chapters WHERE workspace LIKE 'demo-%' LIMIT 1",
        )
        .get();
      const state = JSON.parse(row.data);
      update(state);
      db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(
        JSON.stringify(state),
        row.workspace,
      );
    } finally {
      db.close();
    }
  };
  return { api, switchTo, editState, directory, env };
}

test("semester reset requires chair, CSRF and a current concrete preview", async (t) => {
  const app = await portal(t);
  await app.switchTo("alex");
  assert.equal((await app.api("/api/semester/preview")).status, 403);
  await app.switchTo("chair");
  assert.equal(
    (
      await app.api(
        "/api/semester/reset",
        { confirm: "DELETE SEMESTER", semester },
        { headers: { "x-csrf-token": "wrong" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await app.api("/api/semester/reset", {
        confirm: "DELETE SEMESTER",
        semester,
      })
    ).status,
    409,
  );
  const preview = await app.api("/api/semester/preview");
  assert.equal(preview.status, 200);
  assert.ok(preview.value.previewToken);
  assert.ok(preview.value.counts.submissions > 0);
  app.editState((state) => {
    state.submissions[0].status = "denied";
  });
  assert.equal(
    (
      await app.api("/api/semester/reset", {
        confirm: "DELETE SEMESTER",
        semester,
        previewToken: preview.value.previewToken,
      })
    ).status,
    409,
  );
  assert.ok((await app.api("/api/submissions")).value.submissions.length > 0);
});

test("semester reset removes academic evidence, preserves accounts and reopens with new dates", async (t) => {
  const app = await portal(t);
  await app.switchTo("alex");
  const uploaded = await app.api("/api/uploads", {
    name: "grade.pdf",
    mime: "application/pdf",
    base64: Buffer.from("%PDF-1.7\nproof").toString("base64"),
  });
  assert.equal(uploaded.status, 201);
  const file = join(
    app.directory,
    "demo",
    "evidence",
    `${uploaded.value.upload.id}.bin`,
  );
  await access(file);
  await app.switchTo("chair");
  const membersBefore = (await app.api("/api/roster")).value.members;
  const preview = (await app.api("/api/semester/preview")).value;
  const reset = await app.api("/api/semester/reset", {
    confirm: "DELETE SEMESTER",
    semester,
    previewToken: preview.previewToken,
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.value.reset.status, "purging");
  assert.equal((await app.api("/api/submissions")).value.submissions.length, 0);
  assert.equal(
    (await app.api(`/api/uploads/${uploaded.value.upload.id}`)).status,
    404,
  );
  await app.switchTo("alex");
  assert.equal(
    (await app.api("/api/submissions", { evidence: "sample" })).status,
    423,
  );
  assert.equal(
    (
      await app.api("/api/uploads", {
        name: "new.pdf",
        mime: "application/pdf",
        base64: "JVBERi0=",
      })
    ).status,
    423,
  );
  await app.switchTo("chair");
  const done = await app.api("/api/semester/reset/resume", {});
  assert.equal(done.status, 200);
  assert.equal(done.value.reset.status, "completed");
  await assert.rejects(access(file), { code: "ENOENT" });
  assert.deepEqual(
    (await app.api("/api/roster")).value.members.map((m) => m.id),
    membersBefore.map((m) => m.id),
  );
  const events = (await app.api("/api/audit")).value.events;
  assert.ok(events.some((event) => event.action === "semester.reset.complete"));
  assert.ok(!events.some((event) => event.action === "evidence.upload"));
  await app.switchTo("alex");
  assert.equal(
    (await app.api("/api/session")).value.user.checkpointDate,
    "2026-10-01",
  );
  assert.equal((await app.api("/api/points")).value.approved, 0);
  assert.equal(
    (await app.api("/api/rules")).value.semester.name,
    semester.name,
  );
  assert.equal(
    (
      await app.api("/api/submissions", {
        title: "Old semester work",
        course: "Math",
        activity: "major",
        date: "2026-08-31",
        grade: 95,
        evidence: "sample",
        confirm: true,
      })
    ).status,
    422,
  );
});

test("roster eligibility uses fresh explicit IDs and keeps chair recovery available", async (t) => {
  const app = await portal(t, {
    ROSTER_SHEET_ID: "a".repeat(30),
    ROSTER_SERVICE_ACCOUNT_EMAIL: "roster@example.iam.gserviceaccount.com",
    ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----",
  });
  await app.switchTo("alex");
  const snapshot = (ids) => ({
    ids,
    fetchedAt: new Date().toISOString(),
    revision: "test-revision",
    source: rosterStatus(app.env).source,
  });
  app.editState((state) => {
    state.roster = snapshot(["alex"]);
  });
  assert.equal((await app.api("/api/session")).status, 200);
  app.editState((state) => {
    state.roster = snapshot(["jordan"]);
  });
  assert.equal((await app.api("/api/session")).status, 403);
  app.editState((state) => {
    state.roster = {
      ...snapshot(["alex"]),
      fetchedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    };
    state.rosterSyncAttempt = {
      id: "other-instance",
      source: rosterStatus(app.env).source,
      expiresAt: Date.now() + 40_000,
    };
  });
  const waiting = await app.api("/api/session");
  assert.equal(waiting.status, 503);
  assert.match(waiting.value.error, /already in progress/);
  app.editState((state) => {
    delete state.rosterSyncAttempt;
  });
  await app.switchTo("chair");
  assert.equal((await app.api("/api/admin/roster-sync")).status, 200);
  assert.equal((await app.api("/api/admin/roster-sync", {})).status, 503);
  const cooldown = await app.api("/api/admin/roster-sync", {});
  assert.equal(cooldown.status, 503);
  assert.match(cooldown.value.error, /thirty seconds/);
  assert.ok((await app.api("/api/admin/roster-sync")).value.retryAt);
  assert.equal((await app.api("/api/roster")).status, 200);
  await app.switchTo("alex");
  app.editState((state) => {
    state.roster = {
      ...snapshot(["alex"]),
      fetchedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    };
  });
  assert.equal((await app.api("/api/session")).status, 503);
  assert.equal((await app.api("/api/logout", {})).status, 200);
});

test("read-only email roster gates members by exact verified account email", async (t) => {
  const app = await portal(t, {
    ROSTER_SOURCE_MODE: "public_email_csv",
    ROSTER_SHEET_ID: "a".repeat(44),
    ROSTER_SHEET_GID: "0",
  });
  await app.switchTo("chair");
  app.editState((state) => {
    state.roster = {
      emails: ["noah.knickerbocker@example.edu", "new.member@example.edu"],
      directory: [
        { name: "Noah Knickerbocker", email: "noah.knickerbocker@example.edu" },
        { name: "New Member", email: "new.member@example.edu" },
      ],
      fetchedAt: new Date().toISOString(),
      revision: "test-revision",
      source: rosterStatus(app.env).source,
    };
  });
  const source = await app.api("/api/admin/roster-sync");
  assert.equal(source.status, 200);
  assert.equal(source.value.mode, "public_email_csv");
  assert.equal(source.value.activeCount, 2);
  assert.deepEqual(source.value.candidates.map((entry) => entry.accountStatus), ["missing_sign_in", "not_invited"]);
  await app.switchTo("alex");
  assert.equal((await app.api("/api/session")).value.rosterEligibility.eligible, true);
  assert.equal((await app.api("/api/admin/roster-sync")).status, 403);
  app.editState((state) => {
    state.roster.emails = ["jordan.ellis@example.edu"];
  });
  assert.equal((await app.api("/api/session")).status, 403);
  await app.switchTo("chair");
  assert.equal((await app.api("/api/session")).status, 200);
});
