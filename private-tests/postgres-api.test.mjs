import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { openDatabase } from "../server/database.mjs";

const databaseURL = process.env.TEST_DATABASE_URL;

test(
  "two Node instances share sessions and serialize conflicting approvals in real PostgreSQL",
  { skip: !databaseURL },
  async () => {
    const env = {
      ...process.env,
      APP_MODE: "demo",
      DATABASE_URL: databaseURL,
      DATABASE_SSL: "disable",
      VERCEL: "",
      VERCEL_ENV: "",
      PUBLIC_ORIGIN: "http://127.0.0.1:4176",
      SUPABASE_URL: "https://fixture.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_disposable_fixture_only",
      SUPABASE_STORAGE_BUCKET: "scholarship-evidence",
      ROSTER_REQUIRED: "",
      ROSTER_SHEET_ID: "",
      ROSTER_SERVICE_ACCOUNT_EMAIL: "",
      ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "",
      ROSTER_SHEET_RANGE: "",
    };
    const db = await openDatabase({ env, migrate: true });
    const children = [];
    let cookie = "",
      csrf = "",
      workspace;
    async function start() {
      const socket = createServer();
      socket.listen(0, "127.0.0.1");
      await once(socket, "listening");
      const port = socket.address().port;
      await new Promise((resolve) => socket.close(resolve));
      const child = spawn(process.execPath, ["server/private.mjs"], {
        cwd: new URL("..", import.meta.url),
        env: { ...env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      await new Promise((resolve, reject) => {
        let output = "",
          errors = "";
        const timer = setTimeout(
          () => reject(Error("Postgres app startup timed out: " + errors)),
          15000,
        );
        child.stderr.on("data", (chunk) => {
          errors += chunk;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(Error(`Postgres app exited ${code}: ${errors}`));
        });
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("ATO scholarship private:")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return `http://127.0.0.1:${port}`;
    }
    async function request(base, path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: env.PUBLIC_ORIGIN,
          "Content-Type": "application/json",
          "X-ATO-Demo": "1",
          "X-CSRF-Token": csrf,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      const payload = await response.json();
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      if (payload.csrfToken) csrf = payload.csrfToken;
      return { ...payload, status: response.status };
    }
    try {
      const [a, b] = await Promise.all([start(), start()]);
      assert.equal((await request(a, "/api/demo/session", {})).status, 200);
      assert.equal((await request(b, "/api/session")).user.id, "alex");
      const sessionId = createHash("sha256")
        .update(cookie.slice(cookie.indexOf("=") + 1))
        .digest("hex");
      const record = await db
        .prepare("SELECT workspace FROM sessions WHERE id=?")
        .get(sessionId);
      workspace = record.workspace;
      const claim = {
        title: "Postgres concurrent quiz",
        course: "MTH 2002",
        activity: "major",
        grade: 95,
        date: "2026-09-28",
        evidence: "sample",
        confirm: true,
      };
      const duplicates = await Promise.all([
        request(a, "/api/submissions", claim),
        request(b, "/api/submissions", claim),
      ]);
      assert.deepEqual(duplicates.map((r) => r.status).sort(), [201, 422]);
      const id = duplicates.find((r) => r.status === 201).submission.id;
      await request(a, "/api/demo/session", { persona: "chair" });
      const path = `/api/submissions/${id}/review`;
      const approvals = await Promise.all([
        request(a, path, { decision: "approved", points: 5, note: "" }),
        request(b, path, { decision: "approved", points: 5, note: "" }),
      ]);
      assert.deepEqual(approvals.map((r) => r.status).sort(), [200, 409]);
      const events = (await request(b, "/api/audit")).events.filter(
        (event) =>
          event.subject === id && event.action === "submission.approved",
      );
      assert.equal(events.length, 1);
      await request(a, "/api/demo/session", { persona: "alex" });
      assert.equal((await request(b, "/api/points")).approved, 23);
      await request(a, "/api/logout", {});
      assert.equal((await request(b, "/api/session")).status, 401);
      // A private schema must not be available through Supabase's public API roles.
      for (const role of ["anon", "authenticated"]) {
        const exists = await db
          .prepare("SELECT 1 FROM pg_roles WHERE rolname=?")
          .get(role);
        if (exists) {
          const access = await db
            .prepare(
              "SELECT has_schema_privilege(?,'scholarship_private','USAGE') AS allowed",
            )
            .get(role);
          assert.equal(access.allowed, false);
        }
      }
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode === null) {
            child.kill("SIGTERM");
            await once(child, "exit");
          }
        }),
      );
      if (workspace) {
        await db
          .prepare(
            "DELETE FROM transactions WHERE session_id IN (SELECT id FROM sessions WHERE workspace=?)",
          )
          .run(workspace);
        for (const table of [
          "audit",
          "canvas_leases",
          "canvas_generations",
          "integrations",
          "uploads",
          "sessions",
          "identities",
          "members",
          "chapters",
        ])
          await db
            .prepare(`DELETE FROM ${table} WHERE workspace=?`)
            .run(workspace);
      }
      await db.close();
    }
  },
);
