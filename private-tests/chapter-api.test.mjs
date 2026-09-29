import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const chairId = "aab93409-383f-4d8a-b443-3d940a277153";

async function freePort() {
  const socket = createServer();
  await new Promise((ok) => socket.listen(0, "127.0.0.1", ok));
  const port = socket.address().port;
  await new Promise((ok) => socket.close(ok));
  return port;
}

test("chapter accounts bind aliases, restrict chair actions and stop deactivated logins", async () => {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "ato-chapter-auth-test-"));
  const base = `http://127.0.0.1:${port}`;
  const origin = "https://portal.example.test";
  const child = spawn(process.execPath,
    ["--import", join(root, "private-tests/mock-chapter-auth.mjs"), "server/private.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        APP_MODE: "production", AUTH_MODE: "chapter", PORT: String(port),
        PUBLIC_ORIGIN: origin, PRIVATE_DATA_DIR: directory,
        DATABASE_URL: "", VERCEL: "", VERCEL_ENV: "",
        SUPABASE_URL: "https://chapter-test.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
        SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`,
        SUPABASE_STORAGE_BUCKET: "",
        ROSTER_REQUIRED: "", ROSTER_SHEET_ID: "", ROSTER_SHEET_RANGE: "",
        ROSTER_SERVICE_ACCOUNT_EMAIL: "", ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "",
        CHAIR_AUTH_USER_ID: chairId, CHAIR_ACCOUNT_EMAIL: "chair@example.edu",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  try {
    await new Promise((ok, reject) => {
      const deadline = setTimeout(() => reject(Error(`Server timeout: ${errorOutput}`)), 10_000);
      child.stdout.on("data", () => {
        if (output.includes("ATO scholarship private:")) { clearTimeout(deadline); ok(); }
      });
      child.once("exit", (code) => { clearTimeout(deadline); reject(Error(`Server exited ${code}: ${errorOutput}`)); });
    });
    const request = async (path, body, cookie = "", csrf = "") => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      return { status: response.status, payload,
        cookie: response.headers.get("set-cookie")?.split(";")[0] || cookie };
    };
    const config = await request("/api/config");
    assert.equal(config.payload.chapterAuth.enabled, true);
    assert.equal(config.payload.chapterAuth.configured, true);
    assert.deepEqual(config.payload.providers, []);
    assert.equal((await request("/api/demo/session", {})).status, 404);
    const demoLogin = await fetch(base + "/demo/login", { redirect: "manual" });
    assert.equal(demoLogin.status, 302);
    assert.equal(demoLogin.headers.get("location"), "/demo/?account=member");
    const chairDemoLogin = await fetch(base + "/demo/login?account=demo-chair", { redirect: "manual" });
    assert.equal(chairDemoLogin.status, 302);
    assert.equal(chairDemoLogin.headers.get("location"), "/demo/?account=chair");
    assert.equal((await fetch(base + "/ato-logo.png")).status, 200);
    const demoScript = await fetch(base + "/demo/app.js");
    assert.equal(demoScript.status, 200);
    assert.match(await demoScript.text(), /selectedDemoAccount/);
    assert.equal((await fetch(base + "/demo/demo-worker.js")).status, 200);
    assert.equal((await request("/auth/microsoft")).status, 404);
    const chair = await request("/api/auth/login", {
      identifier: "chair@example.edu", password: "correct-test-password",
    });
    assert.equal(chair.status, 200, JSON.stringify(chair.payload));
    assert.equal(chair.payload.user.role, "chair");
    assert.equal(chair.payload.user.name, "Scholarship Chair Office");
    const chairCookie = chair.cookie;
    const chairCsrf = chair.payload.csrfToken;
    assert.equal((await request("/api/roster", { name: "Member" })).status, 401);
    const added = await request("/api/roster", {
      name: "Sample Member", email: "member@example.edu", badge: "1234",
      tier: 1, credits: 15,
    }, chairCookie, chairCsrf);
    assert.equal(added.status, 201, JSON.stringify(added.payload));
    assert.match(added.payload.loginId, /^KH-[A-F0-9]{10}$/);
    assert.equal((await request("/api/roster", {
      name: "Duplicate", email: "member@example.edu", tier: 1, credits: 15,
    }, chairCookie, chairCsrf)).status, 409);
    const roster = await request("/api/roster", undefined, chairCookie);
    assert.equal(roster.status, 200);
    assert.equal(JSON.stringify(roster.payload).includes("1234"), true);
    assert.equal(JSON.stringify(roster.payload).includes("d4dc3984-9c89-4ff7-8075-cbe5b2cd18c4"), false);

    const member = await request("/api/auth/login", {
      identifier: "1234", password: "correct-test-password",
    });
    assert.equal(member.status, 200, JSON.stringify(member.payload));
    assert.equal(member.payload.user.name, "Sample Member");
    assert.equal((await request("/api/roster", undefined, member.cookie)).status, 403);
    const byEmail = await request("/api/auth/login", {
      identifier: "member@example.edu", password: "correct-test-password",
    });
    assert.equal(byEmail.payload.user.id, member.payload.user.id);
    const byPortalId = await request("/api/auth/login", {
      identifier: added.payload.loginId, password: "correct-test-password",
    });
    assert.equal(byPortalId.payload.user.id, member.payload.user.id);

    const reset = await request(`/api/roster/${member.payload.user.id}/reset-password`, {}, chairCookie, chairCsrf);
    assert.equal(reset.status, 200);
    const publicReset = await request("/api/auth/request-reset", { identifier: "1234" });
    assert.equal(publicReset.status, 200);
    assert.equal((await request("/api/auth/complete", {
      accessToken: "test-account-token", password: "a-long-new-password",
    })).status, 200);
    for (let i = 0; i < 10; i++)
      assert.equal((await request("/api/auth/login", {
        identifier: "unknown-badge", password: "wrong-password",
      })).status, 401);
    assert.equal((await request("/api/auth/login", {
      identifier: "unknown-badge", password: "wrong-password",
    })).status, 429);
    const deactivated = await request(`/api/roster/${member.payload.user.id}/deactivate`, {}, chairCookie, chairCsrf);
    assert.equal(deactivated.status, 200);
    assert.equal((await request("/api/session", undefined, member.cookie)).status, 401);
    assert.equal((await request("/api/auth/login", {
      identifier: "1234", password: "correct-test-password",
    })).status, 401);
    assert.equal((await request("/api/auth/complete", {
      accessToken: "test-chair-account-token", password: "a-new-chair-password",
    })).status, 200);
    assert.equal((await request("/api/session", undefined, chairCookie)).status, 401);
  } finally {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});
