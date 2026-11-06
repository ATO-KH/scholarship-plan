import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { responseCookies } from "./auth-test-helper.mjs";

test("Members manage only their own badge without changing email, permanent login, or sending mail", async t => {
  const root = resolve(import.meta.dirname, ".."), origin = "https://portal.example.test";
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "ato-account-settings-"));
  const providerLog = join(directory, "provider.log"), loginSignal = join(directory, "login.signal");
  const child = spawn(process.execPath, ["--import", join(root, "private-tests/mock-chapter-auth.mjs"), "server/private.mjs"], {
    cwd: root, env: {
      ...process.env, APP_MODE: "production", AUTH_MODE: "chapter", PORT: String(port), PUBLIC_ORIGIN: origin,
      PRIVATE_DATA_DIR: directory, DATABASE_URL: "", VERCEL: "", VERCEL_ENV: "", APP_ENCRYPTION_KEY: "",
      SUPABASE_URL: "https://chapter-test.supabase.co", SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
      SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`, SUPABASE_STORAGE_BUCKET: "",
      TEST_PUBLIC_ROSTER: "true", ROSTER_REQUIRED: "true", ROSTER_SOURCE_MODE: "public_email_csv",
      ROSTER_SHEET_ID: "a".repeat(44), ROSTER_SHEET_GID: "0", ROSTER_SHEET_RANGE: "",
      ROSTER_SERVICE_ACCOUNT_EMAIL: "", ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "", TEST_AUTH_PREENROLLED: "",
      CHAIR_AUTH_USER_ID: "aab93409-383f-4d8a-b443-3d940a277153", CHAIR_ACCOUNT_EMAIL: "chair@example.edu",
      CHAPTER_EMAIL_READY: "false", TEST_AUTH_PROVIDER_LOG: providerLog, TEST_AUTH_TOKEN_SIGNAL: loginSignal, TEST_AUTH_TOKEN_DELAY_EMAIL: "member@example.edu",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Server timeout: ${stderr}`)), 10000);
    child.stdout.on("data", chunk => { if (String(chunk).includes("ATO scholarship private:")) { clearTimeout(timeout); resolve(); } });
    child.once("exit", code => { clearTimeout(timeout); reject(Error(`Server exited ${code}: ${stderr}`)); });
  });
  const request = async (path, body, cookie = "", csrf = "") => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json(), cookie: responseCookies(response, cookie) };
  };
  const route = "/api/account/badge";
  const module = await fetch(`http://127.0.0.1:${port}/badge-ui.mjs`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /^text\/javascript/);
  assert.match(await module.text(), /export async function mountBadgeSettings/);
  assert.equal((await request(route)).status, 401);
  const chair = await request("/api/auth/login", { identifier: "chair@example.edu", password: "correct-test-password" });
  const chairSend = (path, body) => request(path, body, chair.cookie, chair.payload.csrfToken);
  assert.equal((await chairSend("/api/admin/roster-sync", {})).status, 200);
  const prepared = await chairSend("/api/admin/invitations/prepare", {
    name: "Fictional Member", email: "member@example.edu", badge: "00123", tier: 4, credits: 15,
  });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.payload));
  const memberId = prepared.payload.member.id;
  const login = identifier => request("/api/auth/login", { identifier, password: "correct-test-password" });
  const member = await login("00123");
  assert.equal(member.status, 200);
  const send = (path, body) => request(path, body, member.cookie, member.payload.csrfToken);
  assert.equal((await chairSend(route)).status, 403);
  assert.equal((await chairSend(route, { badge: "456", version: "a".repeat(64) })).status, 403);
  const original = (await send(route)).payload;
  assert.equal(original.badge, "00123");
  assert.equal(original.loginId, prepared.payload.loginId);
  const write = (badge, version = original.version, extra = {}) => send(route, { badge, version, ...extra });
  assert.equal((await request(route, { badge: "456", version: original.version }, member.cookie)).status, 403);
  for (const extra of [{ memberId: "other" }, { tier: 1 }, { email: "other@example.edu" }, { name: "Renamed" }])
    assert.equal((await write("456", original.version, extra)).status, 422);
  for (const badge of [900123456, "900123456", "bad badge", "a".repeat(33), "Test1", "TEST2", "KH-1234567890", null])
    assert.equal((await write(badge)).status, 422, `Reject invalid or reserved badge ${badge}`);
  const storage = new DatabaseSync(join(directory, "production", "chapter.sqlite"));
  try {
    const state = () => JSON.parse(storage.prepare("SELECT data FROM chapters WHERE workspace='chapter'").get().data);
    const save = value => storage.prepare("UPDATE chapters SET data=? WHERE workspace='chapter'").run(JSON.stringify(value));
    const alias = value => storage.prepare("SELECT member_id FROM identities WHERE workspace='chapter' AND provider='login' AND subject=?").get(value);
    storage.prepare("INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES ('chapter','other','Other','other@example.edu','member',1,15,1)").run();
    storage.prepare("INSERT INTO identities VALUES ('chapter','login','owned','other')").run();
    let value = state();
    value.invitations["reserved@example.edu"] = { email: "reserved@example.edu", badge: "RESERVED-BADGE", alias: "RESERVED-ALIAS" };
    save(value);
    for (const badge of ["OWNED", "reserved-badge", "reserved-alias"])
      assert.equal((await write(badge)).status, 409);
    const providerBefore = await readFile(providerLog, "utf8");
    const updated = await write("  00456  ");
    assert.equal(updated.status, 200, JSON.stringify(updated.payload));
    assert.equal(updated.payload.badge, "00456");
    assert.equal(updated.payload.loginId, original.loginId);
    assert.equal(alias("00123"), undefined);
    assert.equal(alias("00456").member_id, memberId);
    assert.equal(alias(original.loginId.toLowerCase()).member_id, memberId);
    assert.equal(state().invitations["member@example.edu"].badge, "00456");
    assert.equal(await readFile(providerLog, "utf8"), providerBefore, "Badge edits call no provider");
    assert.equal((await write("stale")).status, 409);
    assert.equal((await login("00123")).status, 401);
    assert.equal((await login("00456")).status, 200);
    assert.equal((await login(original.loginId)).status, 200);
    assert.equal((await login("member@example.edu")).status, 200);
    const chairRoute = `/api/roster/${memberId}/account-settings`;
    const details = (await chairSend(chairRoute)).payload;
    assert.equal((await chairSend(chairRoute, { name: "Fictional Member", badge: "00567", tier: 4, credits: 15, version: details.version })).status, 200);
    assert.equal((await write("stale-member", updated.payload.version)).status, 409, "Chair edits invalidate stale member saves");
    const current = (await send(route)).payload;
    const concurrent = await Promise.all([write("00678", current.version), write("00789", current.version)]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
    const winner = concurrent.find(result => result.status === 200).payload;
    await rm(loginSignal, { force: true });
    const inFlight = login(winner.badge);
    for (let attempt = 0; ; attempt++) {
      if (await readFile(loginSignal, "utf8").catch(() => "")) break;
      if (attempt > 100) throw Error("Delayed login did not start");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const cleared = await write("", winner.version);
    assert.equal(cleared.status, 200);
    assert.equal((await inFlight).status, 401, "An in-flight login cannot finish with the removed badge");
    assert.equal(cleared.payload.badge, "");
    assert.equal(cleared.payload.loginId, original.loginId);
    assert.equal(alias(winner.badge), undefined);
    assert.equal((await send(route)).status, 200, "Current session remains usable");
    assert.equal((await chairSend("/api/admin/invitations/member%40example.edu/reconcile", {})).status, 200);
    assert.equal(alias(winner.badge), undefined, "Reconcile cannot restore the removed badge");
    assert.equal(state().invitations["member@example.edu"].badge, "");
    const savedMember = storage.prepare("SELECT name,email,tier,credits FROM members WHERE id=?").get(memberId);
    assert.deepEqual({ ...savedMember }, { name: "Fictional Member", email: "member@example.edu", tier: 4, credits: 15 });
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='account.badge_updated'").get().n, 3);
    value = state(); value.invitations["member@example.edu"].operation = { until: Date.now() + 60000 }; save(value);
    assert.equal((await write("busy", (await send(route)).payload.version)).status, 409);
    value = state(); delete value.invitations["member@example.edu"].operation; value.roster.emails = []; save(value);
    assert.equal((await send(route)).status, 403);
    assert.equal((await write("removed", cleared.payload.version)).status, 403);
    value = state(); value.roster.emails = ["member@example.edu"]; save(value);
    storage.prepare("UPDATE members SET email='sample@pilot.invalid' WHERE id=?").run(memberId);
    // Pilot checks run after ordinary session eligibility; this account is not an authorized pilot.
    assert.notEqual((await write("pilot", cleared.payload.version)).status, 200);
    storage.prepare("UPDATE members SET email='member@example.edu',active=0 WHERE id=?").run(memberId);
    assert.notEqual((await write("inactive", cleared.payload.version)).status, 200);
    assert.equal(/\/auth\/v1\/(invite|recover)/.test(await readFile(providerLog, "utf8")), false, "No email requested");
  } finally { storage.close(); }
});
