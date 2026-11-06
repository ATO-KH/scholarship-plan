import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { responseCookies } from "./auth-test-helper.mjs";

test("Direct roster API invites unprepared members without per-person preparation and permits later edits", async t => {
  const root = resolve(import.meta.dirname, ".."), origin = "https://portal.example.test";
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "ato-invitations-api-"));
  const child = spawn(process.execPath, ["--import", join(root, "private-tests/mock-chapter-auth.mjs"), "server/private.mjs"], {
    cwd: root, env: {
      ...process.env, APP_MODE: "production", AUTH_MODE: "chapter", PORT: String(port), PUBLIC_ORIGIN: origin,
      PRIVATE_DATA_DIR: directory, DATABASE_URL: "", VERCEL: "", VERCEL_ENV: "", APP_ENCRYPTION_KEY: "",
      SUPABASE_URL: "https://chapter-test.supabase.co", SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
      SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`, SUPABASE_STORAGE_BUCKET: "",
      TEST_PUBLIC_ROSTER: "true", ROSTER_REQUIRED: "true", ROSTER_SOURCE_MODE: "public_email_csv",
      ROSTER_SHEET_ID: "a".repeat(44), ROSTER_SHEET_GID: "0", ROSTER_SHEET_RANGE: "",
      ROSTER_SERVICE_ACCOUNT_EMAIL: "", ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "", TEST_AUTH_PREENROLLED: "",
      CHAIR_AUTH_USER_ID: "aab93409-383f-4d8a-b443-3d940a277153", CHAIR_ACCOUNT_EMAIL: "chair@example.edu", CHAPTER_EMAIL_READY: "true",
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
  const route = email => `/api/admin/invitations/${encodeURIComponent(email)}/invite-roster`;
  assert.equal((await request(route('member@example.edu'), {})).status,401);
  const chair=await request('/api/auth/login',{identifier:'chair@example.edu',password:'correct-test-password'});
  assert.equal(chair.status,200,JSON.stringify(chair.payload));
  const send=(path,body)=>request(path,body,chair.cookie,chair.payload.csrfToken);
  assert.equal((await send('/api/admin/roster-sync',{})).status,200);
  const initial=await send('/api/admin/invitations');
  assert.deepEqual(initial.payload.defaults,{tier:1,credits:15});
  assert.equal(initial.payload.invitations.length,2);
  assert.ok(initial.payload.invitations.every(entry=>entry.status==='unprepared' && entry.canInviteFromRoster && !entry.memberId));
  assert.equal((await request(route('member@example.edu'),{},chair.cookie)).status,403);
  assert.equal((await send(route('member@example.edu'),{tier:5})).status,422);
  assert.equal((await send(route('unlisted@example.edu'),{})).status,409);
  const preview=await send('/api/admin/tier-import');
  assert.equal((await send('/api/admin/tier-import',{snapshot:preview.payload.snapshot,assignments:[{email:'member@example.edu',tier:4}]})).status,200);
  const created=await send(route('member@example.edu'),{});
  assert.equal(created.status,200,JSON.stringify(created.payload));
  assert.equal(created.payload.invitation.status,'sent');
  assert.equal(created.payload.invitation.canInviteFromRoster,false);
  assert.equal(created.payload.member.name,'Sample Member');
  assert.equal(created.payload.member.tier,4);
  assert.equal(created.payload.member.credits,15);
  assert.match(created.payload.loginId,/^KH-[A-F0-9]{10}$/);
  assert.equal((await send(route('member@example.edu'),{})).status,409);
  const storage = new DatabaseSync(join(directory,'production','chapter.sqlite'));
  try {
    const read=()=>JSON.parse(storage.prepare("SELECT data FROM chapters WHERE workspace='chapter'").get().data);
    const save=state=>storage.prepare("UPDATE chapters SET data=? WHERE workspace='chapter'").run(JSON.stringify(state));
    const before=read(), removed=structuredClone(before);
    removed.roster.emails=removed.roster.emails.filter(email=>email!=='new@example.edu'); save(removed);
    assert.equal((await send('/api/admin/invitations')).payload.invitations.find(x=>x.email==='new@example.edu').canInviteFromRoster,false);
    assert.equal((await send(route('new@example.edu'),{})).status,409);
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM members WHERE email='new@example.edu'").get().n,0);
    save(before);
    const newMember=await send(route('new@example.edu'),{});
    assert.equal(newMember.status,200,JSON.stringify(newMember.payload));
    assert.equal(newMember.payload.member.tier,1);
    assert.equal(newMember.payload.member.name,'New Member');
    const edits=`/api/roster/${created.payload.member.id}/account-settings`;
    const beforeEdit=await send(edits);
    const edited=await send(edits,{name:'Corrected Member',badge:'4321',tier:2,credits:12,version:beforeEdit.payload.version});
    assert.equal(edited.status,200,JSON.stringify(edited.payload));
    const afterEdit=await send(edits);
    assert.equal(afterEdit.payload.member.name,'Corrected Member');
    assert.equal(afterEdit.payload.member.tier,2);
    assert.equal(afterEdit.payload.member.credits,12);
    assert.equal(afterEdit.payload.loginId,created.payload.loginId);
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='roster.invitation_send_started'").get().n,2,'edits and status reads do not send emails');
    const member=await request('/api/auth/login',{identifier:'4321',password:'correct-test-password'});
    assert.equal(member.status,200,JSON.stringify(member.payload));
    assert.equal((await request(route('new@example.edu'),{},member.cookie,member.payload.csrfToken)).status,403);
    const final=await send('/api/admin/invitations');
    assert.ok(final.payload.invitations.every(entry=>entry.status==='sent' && !entry.canInviteFromRoster));
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM identities WHERE provider='supabase'").get().n,3);
  } finally {storage.close();}
});
