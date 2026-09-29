import http from "node:http";
import { readFile, writeFile, mkdir, unlink, access } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { openDatabase } from "./database.mjs";
import {
  chapterAuthConfigured,
  chairAccountConfigured,
  verifyPassword,
  inviteAccount,
  sendPasswordReset,
  userForAccountToken,
  setPasswordWithToken,
  setPasswordByAdmin,
} from "./chapter-auth.mjs";
import {
  issueSemesterRecoveryKey,
  beginRecovery,
  cancelRecovery,
  finishRecovery,
  clearRecoveryKey,
} from "./recovery.mjs";
import { rosterStatus, fetchRosterSnapshot } from "./roster.mjs";
import {
  storageStatus,
  verifyStorageConfiguration,
  createUploadGrant,
  finalizeStoredEvidence,
  createDownloadGrant,
  removeStoredEvidence,
  deleteStoredEvidenceAndVerify,
} from "./storage.mjs";
import {
  assertAcademicWritesAllowed,
  semesterResetStatus,
  previewSemesterReset,
  startSemesterReset,
  resumeSemesterReset,
  UPLOAD_GRANT_DRAIN_MS,
} from "./semester.mjs";
import {
  TODAY,
  members as demoMembers,
  activities,
  seed,
  totals,
  validateClaim,
} from "./domain.mjs";
import { canvasAssignments, sampleAssignments } from "./canvas-sample.mjs";
import {
  identityProviders,
  startIdentityFlow,
  completeIdentityFlow,
} from "./identity.mjs";
import {
  canvasStatus,
  startCanvasFlow,
  completeCanvasFlow,
  fetchCanvasAssignments,
  refreshCanvasTokens,
  sealTokens,
  openTokens,
} from "./canvas.mjs";

const env = process.env;
const root = resolve(import.meta.dirname, "..");
const mode = env.APP_MODE || "demo";
if (!["demo", "production"].includes(mode))
  throw Error("APP_MODE must be demo or production.");
const production = mode === "production";
const chapterEmailReady = env.CHAPTER_EMAIL_READY === "true";
const authMode = env.AUTH_MODE || "chapter";
if (!["microsoft", "chapter"].includes(authMode))
  throw Error("AUTH_MODE must be microsoft or chapter.");
const port = Number(env.PORT || 4175);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("PORT must be a valid port.");
if (production && !env.PUBLIC_ORIGIN)
  throw Error("Production requires PUBLIC_ORIGIN with an exact HTTPS origin.");
const originUrl = new URL(env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
if (
  originUrl.username ||
  originUrl.password ||
  originUrl.pathname !== "/" ||
  originUrl.search ||
  originUrl.hash ||
  (production
    ? originUrl.protocol !== "https:"
    : !["http:", "https:"].includes(originUrl.protocol))
)
  throw Error(
    "PUBLIC_ORIGIN must be an exact origin; production requires HTTPS.",
  );
const origin = originUrl.origin;
const dataDir = resolve(
  env.PRIVATE_DATA_DIR || env.APP_DATA_DIR || resolve(root, "data"),
  mode,
);
const filesDir = resolve(dataDir, "evidence");
const db = await openDatabase({ env, directory: dataDir });
const directUploads = db.kind === "postgres";
if (!directUploads) await mkdir(filesDir, { recursive: true, mode: 0o700 });
if (env.VERCEL || env.VERCEL_ENV) {
  if (!storageStatus(env).configured)
    throw Error("Hosted production requires private object storage.");
  await verifyStorageConfiguration({ env });
}

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const now = () => new Date().toISOString();
const policyDay = () =>
  production
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date())
    : TODAY;
function validDate(date) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
const targetDate = env.SEMESTER_TARGET_DATE || "2026-12-04";
const endDate = env.SEMESTER_END_DATE || null;
if (!validDate(targetDate) || (endDate && !validDate(endDate)))
  throw Error("Semester dates must use valid YYYY-MM-DD dates.");
const checkpoints = [
  { date: "2026-09-12", targets: [10, 14, 18, 23, 30] },
  { date: "2026-10-10", targets: [20, 28, 36, 46, 60] },
  { date: "2026-11-06", targets: [30, 42, 54, 70, 90] },
  { date: targetDate, targets: [40, 55, 70, 90, 120] },
];
function semesterSettings(state = {}) {
  return {
    name: "Fall 2026",
    startDate: null,
    targetDate,
    endDate,
    checkpointDates: checkpoints.slice(0, 3).map((item) => item.date),
    ...state.semester,
    timeZone: "America/New_York",
  };
}
function semesterCheckpoints(state) {
  const semester = semesterSettings(state);
  return checkpoints.map((checkpoint, index) => ({
    ...checkpoint,
    date: index === 3 ? semester.targetDate : semester.checkpointDates[index],
  }));
}
function academicGuard(state, generation) {
  assertAcademicWritesAllowed(state);
  if (
    generation !== undefined &&
    (state.semesterGeneration || null) !== generation
  )
    fail(409, "The semester changed. Refresh before continuing.");
}
async function academicSnapshot(session, expectedGeneration) {
  const state = await stateOf(session.workspace);
  academicGuard(state, expectedGeneration);
  return state.semesterGeneration || null;
}
const sessionCookie = production ? "__Host-ato_session" : "ato_session";
const identityCookie = production ? "__Host-ato_identity" : "ato_identity";
const SESSION_LIFETIME = 8 * 60 * 60 * 1000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
const loginAlias = () => `KH-${randomBytes(5).toString("hex").toUpperCase()}`;
function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function cookie(name, value, maxAge = SESSION_LIFETIME / 1000) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${production || originUrl.protocol === "https:" ? "; Secure" : ""}`;
}
function getCookie(req, name) {
  const found = (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (found.length !== 1) return null;
  const value = found[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
async function atomic(fn) {
  return db.transaction(fn);
}
async function lockWorkspace(workspace) {
  const row = await db
    .prepare("SELECT workspace FROM chapters WHERE workspace=? FOR UPDATE")
    .get(workspace);
  if (!row) fail(404, "Chapter workspace not found.");
}
async function assertActiveSession(session, user, checkEligibility = true) {
  const fresh = await db
    .prepare("SELECT id FROM sessions WHERE id=? AND expires>?")
    .get(session.id, Date.now());
  const currentMember = await member(session.workspace, user.id);
  if (!fresh || !currentMember?.active || currentMember.role !== user.role)
    fail(401, "Your account session is no longer active.");
  if (checkEligibility && user.role !== "chair")
    assertRosterEligibility(await stateOf(session.workspace), user);
}

function rosterView(state) {
  const config = rosterStatus(env);
  const snapshot = state.roster;
  const age = Date.now() - Date.parse(snapshot?.fetchedAt);
  const fresh =
    config.configured &&
    !state.rosterSyncError &&
    snapshot?.source === config.source &&
    Array.isArray(snapshot?.ids) &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < config.maxAgeMs;
  return {
    ...config,
    fresh,
    fetchedAt: snapshot?.fetchedAt || null,
    revision: snapshot?.revision || null,
    activeCount: snapshot?.ids?.length || 0,
    refreshing: (state.rosterSyncAttempt?.expiresAt || 0) > Date.now(),
    retryAt: state.rosterSyncError?.retryAt || null,
    lastError: state.rosterSyncError
      ? "Roster synchronization failed. Check the configured sheet and try again."
      : null,
  };
}
function assertRosterEligibility(state, user) {
  const status = rosterView(state);
  if (!status.required || user.role === "chair") return;
  if (!status.fresh)
    fail(
      503,
      "Current roster eligibility is unavailable. Ask the Scholarship Chair to refresh the roster.",
    );
  if (!state.roster.ids.includes(user.id))
    fail(
      403,
      "Your account is not active on the current chapter roster. Contact the Scholarship Chair.",
    );
}
async function refreshRoster(session, user, force = false) {
  const attempt = randomUUID();
  const source = rosterStatus(env).source;
  const existing = await atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user, false);
    const state = await stateOf(session.workspace);
    if (!force && rosterView(state).fresh) return state;
    if (
      state.rosterSyncAttempt?.source === source &&
      state.rosterSyncAttempt.expiresAt > Date.now()
    )
      fail(
        503,
        "Roster refresh is already in progress. Try again in a few seconds.",
      );
    if (
      state.rosterSyncError?.source === source &&
      Date.parse(state.rosterSyncError.retryAt) > Date.now()
    )
      fail(
        503,
        "Roster refresh failed recently. Wait thirty seconds before retrying.",
      );
    state.rosterSyncAttempt = {
      id: attempt,
      source,
      expiresAt: Date.now() + 45_000,
    };
    await db
      .prepare("UPDATE chapters SET data=? WHERE workspace=?")
      .run(JSON.stringify(state), session.workspace);
    return null;
  });
  if (existing) return existing;
  let snapshot;
  try {
    snapshot = await fetchRosterSnapshot({ env });
  } catch (error) {
    await atomic(async () => {
      await lockWorkspace(session.workspace);
      await assertActiveSession(session, user, false);
      const state = await stateOf(session.workspace);
      if (state.rosterSyncAttempt?.id !== attempt) return;
      state.rosterSyncError = {
        at: now(),
        source,
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      };
      delete state.rosterSyncAttempt;
      await db
        .prepare("UPDATE chapters SET data=? WHERE workspace=?")
        .run(JSON.stringify(state), session.workspace);
    });
    throw error;
  }
  return atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user, false);
    const state = await stateOf(session.workspace);
    if (
      state.rosterSyncAttempt?.id !== attempt ||
      state.rosterSyncAttempt.expiresAt <= Date.now()
    )
      return state;
    state.roster = snapshot;
    delete state.rosterSyncError;
    delete state.rosterSyncAttempt;
    await db
      .prepare("UPDATE chapters SET data=? WHERE workspace=?")
      .run(JSON.stringify(state), session.workspace);
    await audit(
      session.workspace,
      user.name,
      "roster.sync",
      "",
      `${state.roster.ids.length} eligible member IDs`,
    );
    return state;
  });
}

async function audit(workspace, actor, action, subject = "", detail = "") {
  await db
    .prepare(
      "INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)",
    )
    .run(workspace, now(), actor || "system", action, subject, detail);
}
async function member(workspace, id) {
  const row = await db
    .prepare("SELECT * FROM members WHERE workspace=? AND id=?")
    .get(workspace, id);
  if (!row) return null;
  const schedule = semesterCheckpoints(await stateOf(workspace));
  const checkpoint =
    schedule.find((c) => c.date >= policyDay()) || schedule.at(-1);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    tier: row.tier,
    credits: row.credits,
    active: !!row.active,
    initials: row.name
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase(),
    ...(row.role === "member"
      ? {
          goal: [40, 55, 70, 90, 120][row.tier - 1],
          checkpoint: checkpoint.targets[row.tier - 1],
          checkpointDate: checkpoint.date,
          gpa: "Chair assigned",
        }
      : {}),
  };
}
async function listMembers(workspace) {
  return await Promise.all(
    (
      await db
        .prepare("SELECT id FROM members WHERE workspace=? ORDER BY name")
        .all(workspace)
    ).map(async (row) => await member(workspace, row.id)),
  );
}
async function insertMember(workspace, m) {
  await db
    .prepare(
      "INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES (?,?,?,?,?,?,?,1)",
    )
    .run(
      workspace,
      m.id,
      m.name,
      m.email,
      m.role,
      m.tier ?? null,
      m.credits ?? null,
    );
}
async function identityMember(workspace, provider, subject) {
  return db
    .prepare(
      "SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?",
    )
    .get(workspace, provider, subject);
}
async function accountForIdentifier(identifier) {
  const normalized = identifier.trim().toLowerCase();
  if (normalized.includes("@")) {
    const row = await db
      .prepare("SELECT id FROM members WHERE workspace=? AND LOWER(email)=?")
      .get("chapter", normalized);
    return row ? member("chapter", row.id) : null;
  }
  const row = await identityMember("chapter", "login", normalized);
  return row ? member("chapter", row.member_id) : null;
}
async function authAttempt(kind, identifier, maxAttempts) {
  const id = sha(`${kind}:${identifier.trim().toLowerCase()}`);
  await atomic(async () => {
    await db
      .prepare(
        "INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, kind, null, "0", Date.now() + 900_000);
    const row = await db
      .prepare("SELECT data,expires FROM transactions WHERE id=? FOR UPDATE")
      .get(id);
    const attempts = row.expires > Date.now() ? Number(row.data) : 0;
    if (attempts >= maxAttempts)
      fail(429, "Too many attempts. Try again later.");
    await db
      .prepare("UPDATE transactions SET data=?,expires=? WHERE id=?")
      .run(
        String(attempts + 1),
        row.expires > Date.now() ? row.expires : Date.now() + 900_000,
        id,
      );
  });
}
async function clearAuthAttempts(kind, identifier) {
  await db.prepare("DELETE FROM transactions WHERE id=?")
    .run(sha(`${kind}:${identifier.trim().toLowerCase()}`));
}
async function stateOf(workspace) {
  return JSON.parse(
    (
      await db
        .prepare("SELECT data FROM chapters WHERE workspace=?")
        .get(workspace)
    ).data,
  );
}
async function currentSession(req) {
  const raw = getCookie(req, sessionCookie);
  if (!raw) return null;
  return (
    (await db
      .prepare("SELECT * FROM sessions WHERE id=? AND expires>?")
      .get(sha(raw), Date.now())) || null
  );
}
async function requireSession(req) {
  const session = await currentSession(req);
  const user = session && (await member(session.workspace, session.member_id));
  if (!session || !user?.active)
    fail(401, "Sign in to an active chapter account.");
  if (user.role !== "chair" && req.url?.split("?")[0] !== "/api/logout") {
    let state = await stateOf(session.workspace);
    const status = rosterView(state);
    if (status.required && !status.fresh)
      state = await refreshRoster(session, user);
    assertRosterEligibility(state, user);
  }
  return { session, user };
}
function chair(user) {
  if (user.role !== "chair")
    fail(403, "Only the Scholarship Chair can perform this action.");
}
function individual(user) {
  if (user.role !== "member")
    fail(403, "Use a member account for individual submissions.");
}
function requireOrigin(req) {
  if (req.headers.origin !== origin)
    fail(403, "The request origin does not match this portal.");
  if (req.headers["sec-fetch-site"] === "cross-site")
    fail(403, "Cross-site requests are not accepted.");
}
function csrf(req, session) {
  requireOrigin(req);
  if (!equal(req.headers["x-csrf-token"], session.csrf))
    fail(
      403,
      "The security token is missing or expired. Refresh and try again.",
    );
}
async function issueSession(workspace, userId, previousId = null) {
  if (previousId)
    await db.prepare("DELETE FROM sessions WHERE id=?").run(previousId);
  const raw = token();
  const session = {
    id: sha(raw),
    workspace,
    member_id: userId,
    csrf: token(),
    expires: Date.now() + SESSION_LIFETIME,
  };
  await db
    .prepare("INSERT INTO sessions VALUES (?,?,?,?,?)")
    .run(session.id, workspace, userId, session.csrf, session.expires);
  return { session, cookie: cookie(sessionCookie, raw) };
}
async function cleanup() {
  await db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
  await db.prepare("DELETE FROM transactions WHERE expires<=?").run(Date.now());
}
async function mutate(session, user, fn) {
  return await atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user);
    const state = await stateOf(session.workspace);
    const result = await fn(state);
    await db
      .prepare("UPDATE chapters SET data=? WHERE workspace=?")
      .run(JSON.stringify(state), session.workspace);
    return result;
  });
}
function canvasConfigured() {
  if (!canvasStatus(env).configured) return false;
  const key = env.APP_ENCRYPTION_KEY;
  return (
    typeof key === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(key) &&
    Buffer.from(key, "base64").length === 32 &&
    Buffer.from(key, "base64").toString("base64") === key
  );
}
async function connection(session) {
  return await db
    .prepare("SELECT * FROM integrations WHERE workspace=? AND member_id=?")
    .get(session.workspace, session.member_id);
}
async function advanceCanvasGeneration(workspace, userId) {
  const generation = randomUUID();
  await db
    .prepare(
      "INSERT INTO canvas_generations VALUES (?,?,?) ON CONFLICT(workspace,member_id) DO UPDATE SET generation=excluded.generation",
    )
    .run(workspace, userId, generation);
  await db
    .prepare(
      "DELETE FROM transactions WHERE kind='canvas' AND session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)",
    )
    .run(workspace, userId);
  return generation;
}
async function sessionPayload(session, user) {
  const state = await stateOf(session.workspace);
  return {
    user,
    csrfToken: session.csrf,
    mode,
    today: policyDay(),
    canvasConnected: !!(await connection(session)),
    semester: semesterSettings(state),
    semesterReset: semesterResetStatus(state),
    rosterEligibility: {
      required: rosterStatus(env).required,
      eligible:
        user.role === "chair" ||
        !rosterStatus(env).required ||
        (rosterView(state).fresh && state.roster.ids.includes(user.id)),
      fresh: rosterView(state).fresh,
      fetchedAt: state.roster?.fetchedAt || null,
    },
  };
}
function json(res, status, value, headers = {}) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
    fail(413, "Report is too large; contact the portal administrator.");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(serialized);
}
function redirect(res, url, headers = {}) {
  res.writeHead(302, { Location: url, ...headers });
  res.end();
}
async function readBody(req, limit = 30_000) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    fail(415, "Send JSON content.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, "Request is too large.");
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    fail(400, "Invalid JSON.");
  }
  if (!data || Array.isArray(data) || typeof data !== "object")
    fail(400, "Send a JSON object.");
  return data;
}
function ownSubmission(state, user, id) {
  const item = state.submissions.find((s) => s.id === id);
  if (!item || (user.role !== "chair" && item.owner !== user.id))
    fail(404, "Submission not found.");
  return item;
}
function claim(input, state, user, evidence) {
  const semester = semesterSettings(state);
  if (semester.startDate && input.date < semester.startDate)
    fail(422, "This activity is before the current semester start date.");
  if (production && semester.endDate && policyDay() > semester.endDate)
    fail(422, "This semester submission period has closed.");
  try {
    // The shared demo scorer validates dates, caps and duplicates. Actual evidence
    // authorization has already happened here; its sample sentinel is internal only.
    return {
      ...validateClaim(
        { ...input, evidence: "sample" },
        state,
        user,
        policyDay(),
      ),
      evidence,
    };
  } catch (error) {
    if (error.status) throw error;
    fail(422, error.message);
  }
}
function newSubmission(value, user, extra = {}) {
  return {
    ...value,
    id: `S-${randomUUID()}`,
    owner: user.id,
    status: "pending",
    awarded: 0,
    submittedAt: now(),
    reviewNote: "",
    history: [{ event: "Submitted for review", at: now() }],
    ...extra,
  };
}
function uploadMeta(upload) {
  return {
    id: upload.id,
    name: upload.name,
    mime: upload.mime,
    size: upload.size,
    url: `/api/uploads/${upload.id}`,
  };
}
async function getUpload(id, session, user, ownerOnly = false) {
  const upload =
    typeof id === "string" &&
    (await db
      .prepare("SELECT * FROM uploads WHERE id=? AND workspace=?")
      .get(id, session.workspace));
  if (
    !upload ||
    upload.status !== "ready" ||
    (upload.owner !== user.id && (ownerOnly || user.role !== "chair"))
  )
    fail(404, "Evidence file not found.");
  return upload;
}
function validUpload(input) {
  const name =
    typeof input.name === "string"
      ? basename(input.name.replaceAll("\\", "/"))
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
      : "";
  if (!name || name.length > 150)
    fail(422, "Choose a file name of at most 150 characters.");
  if (!["application/pdf", "image/png", "image/jpeg"].includes(input.mime))
    fail(422, "Only PDF, PNG and JPEG evidence files are accepted.");
  if (typeof input.base64 !== "string" || input.base64.length % 4 !== 0)
    fail(422, "The file encoding is invalid.");
  if (input.base64.length > Math.ceil((5 * 1024 * 1024) / 3) * 4)
    fail(413, "Evidence must be no larger than 5 MiB.");
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.toString("base64") !== input.base64)
    fail(422, "The file encoding is invalid.");
  if (!bytes.length) fail(422, "Choose a nonempty evidence file.");
  if (bytes.length > 5 * 1024 * 1024)
    fail(413, "Evidence must be no larger than 5 MiB.");
  const matches =
    input.mime === "application/pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : input.mime === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!matches)
    fail(422, "The file contents do not match its declared PDF or image type.");
  return { name, bytes, mime: input.mime };
}
function validateRoster(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (
    !name ||
    name.length > 100 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    input.provider !== "microsoft" ||
    !subject ||
    subject.length > 512 ||
    /[\u0000-\u001f]/.test(subject) ||
    !Number.isInteger(input.tier) ||
    input.tier < 1 ||
    input.tier > 5 ||
    !Number.isFinite(input.credits) ||
    input.credits < 0 ||
    input.credits > 30
  )
    fail(
      422,
      "Supply a name, email, provider, stable subject, tier 1–5 and credits 0–30.",
    );
  if (
    input.provider === "microsoft" &&
    !/^[a-f0-9-]{36}:(?:oid|sub):.+$/i.test(subject)
  )
    fail(
      422,
      "Microsoft subject must include the tenant and oid or sub namespace.",
    );
  return {
    name,
    email,
    subject,
    provider: input.provider,
    tier: input.tier,
    credits: input.credits,
  };
}
function validateChapterMember(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const badge = typeof input.badge === "string" ? input.badge.trim().toLowerCase() : "";
  if (
    !name || name.length > 100 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    (badge && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(badge)) ||
    !Number.isInteger(input.tier) || input.tier < 1 || input.tier > 5 ||
    !Number.isFinite(input.credits) || input.credits < 0 || input.credits > 30
  ) fail(422, "Enter a name, valid email, optional badge number, tier and credits.");
  return { name, email, badge, tier: input.tier, credits: input.credits };
}
async function coordinatedCanvasRefresh(
  session,
  user,
  original,
  expectedRevision,
  signal,
) {
  const leaseOwner = randomUUID();
  let acquired = false;
  const deadline = Date.now() + 65_000;
  try {
    while (!acquired) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        fail(503, "Canvas is busy refreshing. Try again shortly.");
      const lease = await db
        .prepare(
          `INSERT INTO canvas_leases(workspace,member_id,owner,expires) VALUES (?,?,?,?)
        ON CONFLICT(workspace,member_id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
        WHERE canvas_leases.expires<=? RETURNING owner`,
        )
        .get(
          session.workspace,
          user.id,
          leaseOwner,
          Date.now() + 60_000,
          Date.now(),
        );
      acquired = lease?.owner === leaseOwner;
      if (!acquired) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await assertActiveSession(session, user);
    const current = await connection(session);
    if (!current || current.revision !== expectedRevision)
      fail(409, "Canvas connection changed. Start again.");
    const currentTokens = openTokens(current.data, env);
    if (currentTokens.accessToken !== original.accessToken)
      return currentTokens;
    const refreshed = await refreshCanvasTokens({
      env,
      tokens: currentTokens,
      redirectUri: `${origin}/auth/canvas/callback`,
      signal,
    });
    await atomic(async () => {
      await lockWorkspace(session.workspace);
      await assertActiveSession(session, user);
      const updated = await db
        .prepare(
          `UPDATE integrations SET data=? WHERE workspace=? AND member_id=? AND revision=?
        AND EXISTS (SELECT 1 FROM canvas_leases WHERE workspace=? AND member_id=? AND owner=? AND expires>?)`,
        )
        .run(
          sealTokens(refreshed, env),
          session.workspace,
          user.id,
          expectedRevision,
          session.workspace,
          user.id,
          leaseOwner,
          Date.now(),
        );
      if (updated.changes !== 1)
        fail(409, "Canvas refresh was superseded. Reconnect or try again.");
    });
    return refreshed;
  } finally {
    if (acquired)
      await db
        .prepare(
          "DELETE FROM canvas_leases WHERE workspace=? AND member_id=? AND owner=?",
        )
        .run(session.workspace, user.id, leaseOwner);
  }
}
async function liveAssignments(session, user) {
  if (!canvasConfigured())
    fail(503, "Canvas is not configured. Contact the portal administrator.");
  const stored = await connection(session);
  if (!stored) fail(409, "Connect your Canvas account first.");
  const assignments = await fetchCanvasAssignments({
    env,
    tokens: openTokens(stored.data, env),
    redirectUri: `${origin}/auth/canvas/callback`,
    refreshTokens: (tokens, options) =>
      coordinatedCanvasRefresh(
        session,
        user,
        tokens,
        stored.revision,
        options?.signal,
      ),
  });
  await assertActiveSession(session, user);
  if ((await connection(session))?.revision !== stored.revision)
    fail(409, "Canvas connection changed. Start again.");
  return { assignments, revision: stored.revision };
}

async function deleteEvidenceObject({ backend, path }) {
  if (backend === "supabase")
    return deleteStoredEvidenceAndVerify({ path, env });
  if (backend !== "local" || !/^[a-f0-9-]{36}\.bin$/i.test(path))
    fail(503, "Evidence cleanup requires administrator review.");
  const file = resolve(filesDir, path);
  await unlink(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  try {
    await access(file);
  } catch (error) {
    if (error.code === "ENOENT") return { deleted: true };
    throw error;
  }
  fail(503, "Evidence deletion could not yet be verified.");
}

// Failed/terminated finalization keeps both object references until a bounded,
// retryable deletion proves they are absent after the replayable grant expires.
async function cleanupExpiredUpload(session, user) {
  const stale = await atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user);
    const row = await db
      .prepare(
        "SELECT * FROM uploads WHERE workspace=? AND backend='supabase' AND status IN ('pending','verifying','failed','purging') AND created_at<=? ORDER BY created_at LIMIT 1 FOR UPDATE",
      )
      .get(
        session.workspace,
        new Date(Date.now() - UPLOAD_GRANT_DRAIN_MS).toISOString(),
      );
    if (!row) return null;
    await db
      .prepare("UPDATE uploads SET status='purging' WHERE id=?")
      .run(row.id);
    return row;
  });
  if (!stale) return { cleaned: 0 };
  for (const path of new Set(
    [stale.filename, stale.final_path].filter(Boolean),
  ))
    await deleteEvidenceObject({ backend: "supabase", path });
  await atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user);
    await db
      .prepare("DELETE FROM uploads WHERE id=? AND status='purging'")
      .run(stale.id);
  });
  return { cleaned: 1 };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${directUploads ? storageStatus(env).origin || "" : ""}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );
  if (production)
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  try {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (!["GET", "POST"].includes(req.method)) fail(405, "Method not allowed.");
    if (path === "/api/config" && req.method === "GET") {
      const current = await currentSession(req);
      const state = production
        ? await stateOf("chapter")
        : current
          ? await stateOf(current.workspace)
          : {};
      return json(res, 200, {
        mode,
        providers: authMode === "chapter" ? [] : identityProviders(env),
        chapterAuth: {
          enabled: authMode === "chapter",
          configured: chapterAuthConfigured(env) && chairAccountConfigured(env),
          emailReady: chapterEmailReady,
        },
        canvasConfigured: canvasConfigured(),
        uploadMode: directUploads ? "direct" : "local",
        semester: semesterSettings(state),
      });
    }
    if (production && path.startsWith("/api/demo/")) fail(404, "Not found.");
    if (production && authMode === "chapter" && path === "/api/auth/login" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      const input = await readBody(req);
      const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!identifier || identifier.length > 254 || !password || password.length > 1024)
        fail(422, "Enter your email or member ID and password.");
      const candidate = await accountForIdentifier(identifier);
      const attemptKey = candidate?.id || identifier;
      await authAttempt("login_attempt", attemptKey, 10);
      const bootstrapEmail = env.CHAIR_ACCOUNT_EMAIL?.trim().toLowerCase();
      const email = candidate?.email ||
        (identifier.toLowerCase() === bootstrapEmail ? bootstrapEmail :
          `${sha(identifier).slice(0, 24)}@invalid.example`);
      const verified = await verifyPassword(env, email, password);
      if (!verified || verified.email !== email)
        fail(401, "Invalid sign-in details.");
      const issued = await atomic(async () => {
        await lockWorkspace("chapter");
        let binding = await identityMember("chapter", "supabase", verified.id);
        if (
          !binding && !candidate &&
          equal(env.CHAIR_AUTH_USER_ID, verified.id) &&
          equal(env.CHAIR_ACCOUNT_EMAIL?.trim().toLowerCase(), verified.email) &&
          !(await db.prepare("SELECT id FROM members WHERE workspace='chapter' AND role='chair'").get())
        ) {
          const id = randomUUID();
          await insertMember("chapter", {
            id,
            name: "Scholarship Chair Office",
            email: verified.email,
            role: "chair",
          });
          await db.prepare("INSERT INTO identities VALUES (?,?,?,?)")
            .run("chapter", "supabase", verified.id, id);
          await audit("chapter", "system", "chair.bootstrap", id, "Dedicated office account bound to exact Supabase Auth user ID.");
          binding = { member_id: id };
        }
        const user = binding && await member("chapter", binding.member_id);
        if (!user?.active || (candidate && candidate.id !== user.id) || user.email !== verified.email)
          fail(401, "Invalid sign-in details.");
        await audit("chapter", user.name, "session.login", user.id, "chapter");
        return { ...await issueSession("chapter", user.id, (await currentSession(req))?.id), user };
      });
      if (issued.user.role === "member") {
        try {
          let state = await stateOf("chapter");
          if (rosterView(state).required && !rosterView(state).fresh)
            state = await refreshRoster(issued.session, issued.user);
          assertRosterEligibility(state, issued.user);
          issued.recoveryKey = await atomic(async () => {
            await lockWorkspace("chapter");
            await assertActiveSession(issued.session, issued.user);
            return issueSemesterRecoveryKey(db, "chapter", issued.user.id,
              (await stateOf("chapter")).semesterGeneration || "initial");
          });
        } catch (error) {
          await db.prepare("DELETE FROM sessions WHERE id=?").run(issued.session.id);
          throw error;
        }
      }
      await clearAuthAttempts("login_attempt", attemptKey);
      return json(res, 200,
        { ...await sessionPayload(issued.session, await member("chapter", issued.session.member_id)),
          ...(issued.recoveryKey ? { recoveryKey: issued.recoveryKey } : {}) },
        { "Set-Cookie": issued.cookie });
    }
    if (production && authMode === "chapter" && path === "/api/auth/request-reset" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      if (!chapterEmailReady) fail(503, "Email resets are not available yet. Members can use their recovery key; the Chair must contact the portal administrator.");
      const input = await readBody(req);
      const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
      if (!identifier || identifier.length > 254) fail(422, "Enter your email or member ID.");
      const candidate = await accountForIdentifier(identifier);
      await authAttempt("reset_attempt", candidate?.id || identifier, 3);
      const linked = candidate && await db
        .prepare("SELECT subject FROM identities WHERE workspace=? AND provider=? AND member_id=?")
        .get("chapter", "supabase", candidate.id);
      if (candidate?.active && linked) {
        try {
          await sendPasswordReset(env, candidate.email, `${origin}/account/reset`);
        } catch {
          // Public reset requests never reveal account presence or mail status.
        }
      }
      return json(res, 200, { message: "If the account is active, a reset link will be sent." });
    }
    if (production && authMode === "chapter" && path === "/api/auth/recover-key" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      const input = await readBody(req);
      const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
      const recoveryKey = typeof input.recoveryKey === "string" ? input.recoveryKey : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!identifier || identifier.length > 254 || recoveryKey.length > 256 ||
          password.length < 12 || password.length > 1024)
        fail(422, "Enter your member ID, 16-word recovery key, and a new password of at least 12 characters.");
      const candidate = await accountForIdentifier(identifier);
      await authAttempt("recovery_attempt", candidate?.id || identifier, 5);
      const linked = candidate?.active && candidate.role === "member" && await db
        .prepare("SELECT subject FROM identities WHERE workspace=? AND provider=? AND member_id=?")
        .get("chapter", "supabase", candidate.id);
      if (!linked) fail(401, "The account or recovery key was not recognized.");
      const reservation = await atomic(async () => {
        await lockWorkspace("chapter");
        const current = await member("chapter", candidate.id);
        if (!current?.active || current.role !== "member")
          fail(401, "The account or recovery key was not recognized.");
        const generation = (await stateOf("chapter")).semesterGeneration || "initial";
        const result = await beginRecovery(db, "chapter", current.id, generation, recoveryKey);
        if (!result) fail(401, "The account or recovery key was not recognized.");
        await audit("chapter", current.name, "account.recovery.started", current.id);
        return result;
      });
      try {
        await setPasswordByAdmin(env, linked.subject, password);
      } catch {
        await atomic(async () => {
          await lockWorkspace("chapter");
          await cancelRecovery(db, "chapter", candidate.id, reservation);
        });
        fail(503, "The password could not be changed. Your recovery key remains valid; try again or contact the portal administrator.");
      }
      const nextKey = await atomic(async () => {
        await lockWorkspace("chapter");
        const generation = (await stateOf("chapter")).semesterGeneration || "initial";
        const key = await finishRecovery(db, "chapter", candidate.id, generation, reservation);
        await audit("chapter", candidate.name, "account.recovery.complete", candidate.id,
          "Password changed; portal sessions revoked; recovery key rotated.");
        return key;
      });
      await clearAuthAttempts("recovery_attempt", candidate.id);
      return json(res, 200, {
        message: "Password changed. Save the new 16-word recovery key, then sign in.",
        recoveryKey: nextKey,
      }, { "Set-Cookie": cookie(sessionCookie, "", 0) });
    }
    if (production && authMode === "chapter" && path === "/api/auth/complete" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      const input = await readBody(req);
      if (typeof input.accessToken !== "string" || input.accessToken.length > 8192 ||
          typeof input.password !== "string" || input.password.length < 12 || input.password.length > 1024)
        fail(422, "Choose a password of at least 12 characters.");
      const account = await userForAccountToken(env, input.accessToken);
      if (!account) fail(401, "This account link has expired. Request a new one.");
      const binding = await identityMember("chapter", "supabase", account.id);
      const user = binding && await member("chapter", binding.member_id);
      if ((!user?.active || user.email !== account.email) &&
          !(equal(env.CHAIR_AUTH_USER_ID, account.id) &&
            equal(env.CHAIR_ACCOUNT_EMAIL?.trim().toLowerCase(), account.email)))
        fail(403, "This account is not approved for the portal.");
      if (!(await setPasswordWithToken(env, input.accessToken, input.password, account.id)))
        fail(401, "This account link has expired. Request a new one.");
      if (user) {
        await atomic(async () => {
          await lockWorkspace("chapter");
          await db.prepare("DELETE FROM sessions WHERE workspace=? AND member_id=?")
            .run("chapter", user.id);
          if (user.role === "member") await clearRecoveryKey(db, "chapter", user.id);
          await audit("chapter", user.name, "account.password_change", user.id,
            "Existing portal sessions revoked after password update.");
        });
      }
      return json(res, 200, { message: "Password set. Sign in to continue." });
    }
    if (path === "/api/demo/session" && req.method === "POST" && !production) {
      requireOrigin(req);
      if (req.headers["x-ato-demo"] !== "1")
        fail(403, "The demo request header is required.");
      const input = await readBody(req);
      let session = await currentSession(req);
      if (session) csrf(req, session);
      const persona = input.persona || session?.member_id || "alex";
      if (!demoMembers.some((m) => m.id === persona))
        fail(422, "Unknown demo persona.");
      await cleanup();
      let workspace = session?.workspace;
      const issued = await atomic(async () => {
        if (!workspace) {
          workspace = `demo-${randomUUID()}`;
          await db
            .prepare("INSERT INTO chapters VALUES (?,?)")
            .run(workspace, JSON.stringify(seed()));
          for (const m of demoMembers) await insertMember(workspace, m);
        }
        return await issueSession(workspace, persona, session?.id);
      });
      return json(
        res,
        200,
        await sessionPayload(issued.session, await member(workspace, persona)),
        { "Set-Cookie": issued.cookie },
      );
    }

    const identityRoute = path.match(
      /^\/auth\/(microsoft|google)(\/callback)?$/,
    );
    if (identityRoute && req.method === "GET") {
      if (identityRoute[1] !== "microsoft" || authMode !== "microsoft") fail(404, "Not found.");
      if (!production)
        fail(
          403,
          "Organization sign-in is disabled in the isolated demonstration.",
        );
      const provider = identityRoute[1];
      const redirectUri = `${origin}/auth/${provider}/callback`;
      if (!identityRoute[2]) {
        await cleanup();
        const flow = startIdentityFlow(provider, { env, redirectUri });
        const browserToken = token();
        await db
          .prepare("INSERT INTO transactions VALUES (?,?,?,?,?)")
          .run(
            sha(browserToken),
            "identity",
            null,
            JSON.stringify(flow.transaction),
            Date.now() + 600_000,
          );
        return redirect(res, flow.url, {
          "Set-Cookie": cookie(identityCookie, browserToken, 600),
        });
      }
      const browserToken = getCookie(req, identityCookie);
      const txn =
        browserToken &&
        (await db
          .prepare(
            "DELETE FROM transactions WHERE id=? AND kind=? AND expires>? RETURNING *",
          )
          .get(sha(browserToken), "identity", Date.now()));
      res.setHeader("Set-Cookie", cookie(identityCookie, "", 0));
      if (!txn || JSON.parse(txn.data).provider !== provider)
        fail(400, "Sign-in expired. Please start again.");
      const identity = await completeIdentityFlow({
        transaction: JSON.parse(txn.data),
        callbackUrl: url.href,
        env,
        redirectUri,
      });
      const issued = await atomic(async () => {
        await lockWorkspace("chapter");
        let binding = await db
          .prepare(
            "SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?",
          )
          .get("chapter", identity.provider, identity.subject);
        if (
          !binding &&
          env.BOOTSTRAP_PROVIDER === identity.provider &&
          equal(env.BOOTSTRAP_SUBJECT, identity.subject) &&
          !(await db
            .prepare(
              "SELECT id FROM members WHERE workspace='chapter' AND role='chair'",
            )
            .get())
        ) {
          const id = randomUUID();
          await insertMember("chapter", {
            id,
            name: env.BOOTSTRAP_NAME?.trim().slice(0, 100) || identity.name,
            email: env.BOOTSTRAP_EMAIL?.trim().slice(0, 254) || identity.email,
            role: "chair",
          });
          await db
            .prepare("INSERT INTO identities VALUES (?,?,?,?)")
            .run("chapter", identity.provider, identity.subject, id);
          await audit(
            "chapter",
            identity.name,
            "chair.bootstrap",
            id,
            "Created from explicitly configured provider and stable subject.",
          );
          binding = { member_id: id };
        }
        const user = binding && (await member("chapter", binding.member_id));
        if (!user?.active)
          fail(
            403,
            "Your verified account is not on the active chapter roster. Ask the Scholarship Chair to add its stable identity.",
          );
        await audit(
          "chapter",
          user.name,
          "session.login",
          user.id,
          identity.provider,
        );
        return await issueSession(
          "chapter",
          user.id,
          (await currentSession(req))?.id,
        );
      });
      return redirect(res, "/", {
        "Set-Cookie": [cookie(identityCookie, "", 0), issued.cookie],
      });
    }

    if (path.startsWith("/auth/canvas") || path.startsWith("/api/")) {
      let { session, user } = await requireSession(req);
      const requestGeneration =
        (await stateOf(session.workspace)).semesterGeneration || null;
      if (req.method === "POST") csrf(req, session);
      const input =
        req.method === "POST"
          ? await readBody(
              req,
              !directUploads && path === "/api/uploads" ? 7_100_000 : 262_144,
            )
          : null;
      // Re-read after request-body or network waits so deactivation and session rotation win.
      ({ session, user } = await requireSession(req));
      if (
        req.headers["x-ato-expected-user"] &&
        req.headers["x-ato-expected-user"] !== user.id
      )
        fail(
          409,
          "The account changed in another tab. Refresh before continuing.",
        );
      if (path === "/api/session" && req.method === "GET")
        return json(res, 200, await sessionPayload(session, user));
      if (path === "/api/me" && req.method === "GET")
        return json(res, 200, { user, mode, today: policyDay() });
      if (path === "/api/admin/roster-sync") {
        chair(user);
        const state =
          req.method === "POST"
            ? await refreshRoster(session, user, true)
            : await stateOf(session.workspace);
        return json(res, 200, rosterView(state));
      }
      if (path === "/api/semester" && req.method === "GET") {
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          semester: semesterSettings(state),
          reset: semesterResetStatus(state),
        });
      }
      if (path === "/api/semester/preview" && req.method === "GET") {
        chair(user);
        return json(
          res,
          200,
          await previewSemesterReset({
            db,
            workspace: session.workspace,
            authorize: () => assertActiveSession(session, user),
          }),
        );
      }
      if (path === "/api/semester/reset" && req.method === "POST") {
        chair(user);
        const reset = await startSemesterReset({
          db,
          workspace: session.workspace,
          actor: user.name,
          confirm: input.confirm,
          semester: input.semester,
          previewToken: input.previewToken,
          authorize: () => assertActiveSession(session, user),
        });
        return json(res, 200, {
          reset,
          semester: semesterSettings(await stateOf(session.workspace)),
        });
      }
      if (path === "/api/semester/reset/resume" && req.method === "POST") {
        chair(user);
        const reset = await resumeSemesterReset({
          db,
          workspace: session.workspace,
          deleteObject: deleteEvidenceObject,
          authorize: () => assertActiveSession(session, user),
        });
        return json(res, 200, {
          reset,
          semester: semesterSettings(await stateOf(session.workspace)),
        });
      }
      if (path === "/api/uploads/cleanup" && req.method === "POST") {
        chair(user);
        return json(res, 200, await cleanupExpiredUpload(session, user));
      }
      if (path === "/api/logout" && req.method === "POST") {
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user, false);
          await db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
          await db
            .prepare("DELETE FROM transactions WHERE session_id=?")
            .run(session.id);
          await audit(session.workspace, user.name, "session.logout", user.id);
        });
        return json(
          res,
          200,
          { loggedOut: true },
          { "Set-Cookie": cookie(sessionCookie, "", 0) },
        );
      }
      if (path === "/api/rules" && req.method === "GET") {
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          activities: activities.map((a) => ({
            ...a,
            proof: production ? a.proof.replaceAll("sample ", "") : a.proof,
          })),
          today: policyDay(),
          submissionWindowDays: 14,
          weeklyStudyHours: 5,
          weeklyMinorAssignments: 3,
          weekConvention:
            "Monday–Sunday, America/New_York (portal convention; policy must confirm)",
          rounding: "Chair must enter whole points and explain any difference.",
          tierSource:
            "Chair-assigned; GPA tier boundaries in the plan conflict.",
          checkpoints: semesterCheckpoints(state),
          semester: semesterSettings(state),
        });
      }
      if (path === "/api/integrations" && req.method === "GET")
        return json(res, 200, {
          providers: identityProviders(env),
          canvas: {
            configured: canvasConfigured(),
            connected: !!(await connection(session)),
          },
        });
      if (
        (path === "/auth/canvas" ||
          path === "/api/integrations/canvas/connect") &&
        req.method === "POST"
      ) {
        individual(user);
        if (!production)
          fail(
            403,
            "Real Canvas connections are disabled in the isolated demonstration.",
          );
        if (!canvasConfigured())
          fail(
            503,
            "Canvas is not configured. Contact the portal administrator.",
          );
        const flow = startCanvasFlow({
          env,
          redirectUri: `${origin}/auth/canvas/callback`,
        });
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const generation = await advanceCanvasGeneration(
            session.workspace,
            user.id,
          );
          await db
            .prepare(
              "INSERT INTO transactions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,session_id=excluded.session_id,data=excluded.data,expires=excluded.expires",
            )
            .run(
              `canvas:${session.id}`,
              "canvas",
              session.id,
              JSON.stringify({ ...flow.transaction, generation }),
              Date.now() + 600_000,
            );
        });
        return json(res, 200, { url: flow.url });
      }
      if (path === "/auth/canvas/callback" && req.method === "GET") {
        individual(user);
        if (!production)
          fail(
            403,
            "Real Canvas connections are disabled in the isolated demonstration.",
          );
        const txn = await db
          .prepare(
            "DELETE FROM transactions WHERE id=? AND kind=? AND session_id=? AND expires>? RETURNING *",
          )
          .get(`canvas:${session.id}`, "canvas", session.id, Date.now());
        if (!txn) fail(400, "Canvas connection expired. Please start again.");
        const tokens = await completeCanvasFlow({
          transaction: JSON.parse(txn.data),
          callbackUrl: url.href,
          env,
          redirectUri: `${origin}/auth/canvas/callback`,
        });
        const fresh = await requireSession(req);
        if (fresh.session.id !== session.id)
          fail(401, "Your account session changed. Reconnect Canvas.");
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const current = await db
            .prepare(
              "SELECT generation FROM canvas_generations WHERE workspace=? AND member_id=? FOR UPDATE",
            )
            .get(session.workspace, user.id);
          if (current?.generation !== JSON.parse(txn.data).generation)
            fail(409, "Canvas connection changed. Start again.");
          await db
            .prepare(
              "INSERT INTO integrations VALUES (?,?,?,?) ON CONFLICT(workspace,member_id) DO UPDATE SET data=excluded.data,revision=excluded.revision",
            )
            .run(
              session.workspace,
              user.id,
              sealTokens(tokens, env),
              randomUUID(),
            );
          await audit(
            session.workspace,
            user.name,
            "canvas.connect",
            user.id,
            canvasStatus(env).origin,
          );
        });
        return redirect(res, "/?canvas=connected");
      }
      if (
        path === "/api/integrations/canvas/disconnect" &&
        req.method === "POST"
      ) {
        individual(user);
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          await db
            .prepare(
              "DELETE FROM integrations WHERE workspace=? AND member_id=?",
            )
            .run(session.workspace, user.id);
          await advanceCanvasGeneration(session.workspace, user.id);
          await audit(
            session.workspace,
            user.name,
            "canvas.disconnect",
            user.id,
            "Removed locally stored authorization.",
          );
        });
        return json(res, 200, {
          disconnected: true,
          note: "Stored credentials removed. You can also revoke the app in Canvas account settings.",
        });
      }
      if (
        path === "/api/integrations/canvas/assignments" &&
        req.method === "GET"
      ) {
        individual(user);
        const assignments = production
          ? (await liveAssignments(session, user)).assignments
          : sampleAssignments(await stateOf(session.workspace), user.id);
        await requireSession(req);
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          mode: production ? "live" : "sample",
          providerConnected: production,
          assignments: assignments.map((a) => ({
            ...a,
            imported: state.submissions.some(
              (s) =>
                s.owner === user.id &&
                String(s.canvasCourseId) === String(a.course_id) &&
                String(s.canvasAssignmentId) === String(a.id) &&
                s.status !== "denied",
            ),
          })),
          note: production
            ? "Current posted grades fetched from your connected Canvas account. The Chair verifies category and policy eligibility."
            : "Fictional Canvas-shaped data. No university API has been contacted.",
        });
      }
      if (path === "/api/integrations/canvas/import" && req.method === "POST") {
        individual(user);
        if (
          input.confirm !== true ||
          !Array.isArray(input.items) ||
          input.items.length < 1 ||
          input.items.length > 10
        )
          fail(422, "Select up to ten assignments and confirm the categories.");
        const generation = await academicSnapshot(session, requestGeneration);
        const fetched = production
          ? await liveAssignments(session, user)
          : { assignments: canvasAssignments };
        const assignments = fetched.assignments;
        const result = await mutate(session, user, async (state) => {
          academicGuard(state, generation);
          if (
            production &&
            (await connection(session))?.revision !== fetched.revision
          )
            fail(
              409,
              "Canvas connection changed. Fetch current assignments again.",
            );
          const imported = [],
            skipped = [];
          for (const selected of input.items) {
            if (
              !selected ||
              !["major", "minor", "lab"].includes(selected.activity)
            )
              fail(
                422,
                "Choose major assignment, minor assignment or lab report.",
              );
            if (production && selected.courseId === undefined)
              fail(422, "A Canvas course ID is required.");
            const a = assignments.find(
              (a) =>
                String(a.id) === String(selected.assignmentId) &&
                (!production ||
                  String(a.course_id) === String(selected.courseId)),
            );
            if (!a)
              fail(
                422,
                "The selected assignment is not a posted grade in your connected account.",
              );
            if (
              state.submissions.some(
                (s) =>
                  s.owner === user.id &&
                  String(s.canvasCourseId) === String(a.course_id) &&
                  String(s.canvasAssignmentId) === String(a.id) &&
                  s.status !== "denied",
              )
            ) {
              skipped.push(a.id);
              continue;
            }
            const gradeDate = production
              ? new Intl.DateTimeFormat("en-CA", {
                  timeZone: "America/New_York",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(new Date(a.submission.posted_at))
              : a.submission.graded_at.slice(0, 10);
            const value = claim(
              {
                title: a.name.slice(0, 120),
                course: a.course.slice(0, 80),
                activity: selected.activity,
                date: gradeDate,
                grade: Math.min(
                  100,
                  (a.submission.score / a.points_possible) * 100,
                ),
                confirm: true,
                note: production
                  ? "Canvas grade release date used for the submission window; Chair must confirm the policy interpretation and category."
                  : "Imported from fictional Canvas sample.",
              },
              state,
              user,
              production ? "canvas" : "sample",
            );
            const item = newSubmission(value, user, {
              source: production ? "canvas" : "canvas-sample",
              canvasCourseId: a.course_id,
              canvasAssignmentId: a.id,
              provenance: {
                provider: "canvas",
                sourceMode: production ? "live" : "sample",
                origin: production ? canvasStatus(env).origin : null,
                owner: user.id,
                courseId: a.course_id,
                assignmentId: a.id,
                score: a.submission.score,
                pointsPossible: a.points_possible,
                rawGradePercent: (a.submission.score / a.points_possible) * 100,
                gradedAt: a.submission.graded_at,
                postedAt: a.submission.posted_at,
                fetchedAt: now(),
                dateBasis: "grade-release",
                categoryConfirmedByMember: selected.activity,
              },
            });
            state.submissions.push(item);
            imported.push(item);
            await audit(
              session.workspace,
              user.name,
              "canvas.import",
              item.id,
              `${a.course_id}:${a.id}`,
            );
          }
          return {
            imported,
            skippedDuplicateAssignmentIds: skipped,
            points: totals(state, user, policyDay()),
          };
        });
        return json(res, 201, {
          mode: production ? "live" : "sample",
          ...result,
        });
      }
      if (path === "/api/uploads/init" && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        if (!directUploads || !storageStatus(env).configured)
          fail(503, "Direct evidence storage is not configured.");
        await cleanupExpiredUpload(session, user);
        const name =
          typeof input.name === "string"
            ? basename(input.name.replaceAll("\\", "/"))
                .replace(/[\u0000-\u001f\u007f]/g, "")
                .trim()
            : "";
        if (
          !name ||
          name.length > 150 ||
          !["application/pdf", "image/png", "image/jpeg"].includes(
            input.mime,
          ) ||
          !Number.isInteger(input.size) ||
          input.size < 1 ||
          input.size > 5 * 1024 * 1024
        )
          fail(
            422,
            "Choose a PDF, PNG or JPEG evidence file of at most 5 MiB.",
          );
        const id = randomUUID();
        const path = `quarantine/${session.workspace}/${user.id}/${id}`;
        const finalPath = `evidence/${session.workspace}/${user.id}/${randomUUID()}`;
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          academicGuard(await stateOf(session.workspace), generation);
          await db
            .prepare(
              "INSERT INTO uploads(id,workspace,owner,name,mime,size,filename,created_at,status,backend,final_path) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              session.workspace,
              user.id,
              name,
              input.mime,
              input.size,
              path,
              now(),
              "pending",
              "supabase",
              finalPath,
            );
        });
        try {
          const grant = await createUploadGrant({ path, env });
          await assertActiveSession(session, user);
          academicGuard(await stateOf(session.workspace), generation);
          return json(res, 201, {
            id,
            upload: { id, name, mime: input.mime, size: input.size },
            uploadUrl: grant.url,
            method: grant.method,
            headers: grant.headers,
            expiresIn: grant.expiresIn,
          });
        } catch (error) {
          await db
            .prepare(
              "UPDATE uploads SET status='failed' WHERE id=? AND status='pending'",
            )
            .run(id);
          throw error;
        }
      }
      const completeUploadRoute = path.match(
        /^\/api\/uploads\/([a-f0-9-]{36})\/complete$/,
      );
      if (completeUploadRoute && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        if (!directUploads) fail(404, "Not found.");
        const intent = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          academicGuard(await stateOf(session.workspace), generation);
          const found = await db
            .prepare(
              "SELECT * FROM uploads WHERE id=? AND workspace=? AND owner=? FOR UPDATE",
            )
            .get(completeUploadRoute[1], session.workspace, user.id);
          if (!found || found.backend !== "supabase")
            fail(404, "Evidence upload not found.");
          if (found.status === "ready") return found;
          if (
            found.status !== "pending" ||
            Date.now() - Date.parse(found.created_at) > 2 * 60 * 60 * 1000
          )
            fail(
              409,
              "This upload expired or has already been completed. Upload a new file.",
            );
          await db
            .prepare(
              "UPDATE uploads SET status='verifying' WHERE id=? AND status='pending'",
            )
            .run(found.id);
          return found;
        });
        if (intent.status === "ready")
          return json(res, 200, { upload: uploadMeta(intent) });
        try {
          const verified = await finalizeStoredEvidence({
            path: intent.filename,
            finalPath: intent.final_path,
            expectedMime: intent.mime,
            expectedSize: intent.size,
            env,
          });
          await atomic(async () => {
            await lockWorkspace(session.workspace);
            await assertActiveSession(session, user);
            academicGuard(await stateOf(session.workspace), generation);
            const changed = await db
              .prepare(
                "UPDATE uploads SET status='ready',size=?,mime=? WHERE id=? AND workspace=? AND owner=? AND status='verifying'",
              )
              .run(
                verified.size,
                verified.mime,
                intent.id,
                session.workspace,
                user.id,
              );
            if (changed.changes !== 1)
              fail(409, "Evidence upload changed. Upload a new file.");
            await audit(
              session.workspace,
              user.name,
              "evidence.upload",
              intent.id,
              `${verified.mime}; ${verified.size} bytes; sha256 ${verified.sha256}`,
            );
          });
          return json(res, 201, {
            upload: uploadMeta({
              ...intent,
              size: verified.size,
              mime: verified.mime,
            }),
          });
        } catch (error) {
          const failed = await db
            .prepare(
              "UPDATE uploads SET status='failed' WHERE id=? AND status='verifying'",
            )
            .run(intent.id);
          const remaining = await db
            .prepare("SELECT status FROM uploads WHERE id=?")
            .get(intent.id);
          if (
            failed.changes === 1 ||
            !remaining ||
            remaining.status === "purging"
          )
            await Promise.allSettled([
              removeStoredEvidence({ path: intent.filename, env }),
              removeStoredEvidence({ path: intent.final_path, env }),
            ]);
          throw error;
        }
      }
      if (path === "/api/uploads" && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        if (directUploads)
          fail(422, "Use the direct evidence upload workflow.");
        const file = validUpload(input);
        const id = randomUUID();
        const filename = `${id}.bin`;
        await writeFile(resolve(filesDir, filename), file.bytes, {
          flag: "wx",
          mode: 0o600,
        });
        try {
          await requireSession(req);
          await atomic(async () => {
            await lockWorkspace(session.workspace);
            await assertActiveSession(session, user);
            academicGuard(await stateOf(session.workspace), generation);
            await db
              .prepare(
                "INSERT INTO uploads(id,workspace,owner,name,mime,size,filename,created_at) VALUES (?,?,?,?,?,?,?,?)",
              )
              .run(
                id,
                session.workspace,
                user.id,
                file.name,
                file.mime,
                file.bytes.length,
                filename,
                now(),
              );
            await audit(
              session.workspace,
              user.name,
              "evidence.upload",
              id,
              `${file.mime}; ${file.bytes.length} bytes`,
            );
          });
        } catch (error) {
          await unlink(resolve(filesDir, filename)).catch(() => {});
          throw error;
        }
        return json(res, 201, {
          upload: uploadMeta({
            id,
            name: file.name,
            mime: file.mime,
            size: file.bytes.length,
          }),
        });
      }
      const uploadRoute = path.match(/^\/api\/uploads\/([a-f0-9-]{36})$/);
      if (uploadRoute && req.method === "GET") {
        const upload = await getUpload(uploadRoute[1], session, user);
        if (upload.backend === "supabase") {
          const grant = await createDownloadGrant({
            path: upload.final_path,
            downloadName: upload.name,
            expiresIn: 60,
            env,
          });
          await assertActiveSession(session, user);
          await getUpload(upload.id, session, user);
          await audit(
            session.workspace,
            user.name,
            "evidence.download",
            upload.id,
            user.role,
          );
          return redirect(res, grant.url);
        }
        if (directUploads)
          fail(404, "Evidence record is not available in hosted storage.");
        const bytes = await readFile(resolve(filesDir, upload.filename));
        await requireSession(req);
        await audit(
          session.workspace,
          user.name,
          "evidence.download",
          upload.id,
          user.role,
        );
        res.writeHead(200, {
          "Content-Type": upload.mime,
          "Content-Length": bytes.length,
          "Content-Disposition": `attachment; filename="evidence${extname(upload.name).replace(/[^.a-z0-9]/gi, "")}"; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
        });
        return res.end(bytes);
      }
      if (path === "/api/points" && req.method === "GET") {
        individual(user);
        return json(res, 200, {
          member: user.id,
          checkpointDate: user.checkpointDate,
          ...totals(await stateOf(session.workspace), user, policyDay()),
        });
      }
      if (path === "/api/members" && req.method === "GET") {
        chair(user);
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          members: (await listMembers(session.workspace))
            .filter((m) => m.role === "member")
            .map((m) => ({ ...m, ...totals(state, m, policyDay()) })),
        });
      }
      if (path === "/api/roster" && req.method === "GET") {
        chair(user);
        return json(res, 200, {
          members: await Promise.all(
            (await listMembers(session.workspace)).map(async (m) => ({
              ...m,
              identities: (await db
                .prepare(
                  "SELECT provider,subject FROM identities WHERE workspace=? AND member_id=?",
                )
                .all(session.workspace, m.id)).filter((item) => item.provider !== "supabase"),
            })),
          ),
        });
      }
      if (path === "/api/roster" && req.method === "POST") {
        chair(user);
        if (production && authMode === "chapter") {
          if (!chapterAuthConfigured(env)) fail(503, "Chapter invitations are not ready.");
          if (!chapterEmailReady) fail(503, "Member invitations require email delivery. The Chair must configure and test chapter email first.");
          const invited = validateChapterMember(input);
          const existing = await db
            .prepare("SELECT id FROM members WHERE workspace=? AND LOWER(email)=?")
            .get(session.workspace, invited.email);
          if (existing) fail(409, "A member already uses this email address.");
          if (invited.badge && await identityMember(session.workspace, "login", invited.badge))
            fail(409, "A member already uses this badge number.");
          const authUserId = await inviteAccount(env, invited.email, `${origin}/account/setup`);
          let created;
          try {
            created = await atomic(async () => {
              await lockWorkspace(session.workspace);
              await assertActiveSession(session, user);
              if (await db.prepare("SELECT id FROM members WHERE workspace=? AND LOWER(email)=?")
                .get(session.workspace, invited.email))
                fail(409, "A member already uses this email address.");
              if (invited.badge && await identityMember(session.workspace, "login", invited.badge))
                fail(409, "A member already uses this badge number.");
              let alias;
              do { alias = loginAlias().toLowerCase(); }
              while (await identityMember(session.workspace, "login", alias));
              const id = randomUUID();
              await insertMember(session.workspace, { ...invited, id, role: "member" });
              for (const [provider, subject] of [
                ["supabase", authUserId], ["login", alias],
                ...(invited.badge ? [["login", invited.badge]] : []),
              ]) await db.prepare("INSERT INTO identities VALUES (?,?,?,?)")
                .run(session.workspace, provider, subject, id);
              await audit(session.workspace, user.name, "roster.invite", id,
                `chapter account; tier ${invited.tier}; credits ${invited.credits}`);
              return { member: await member(session.workspace, id), loginId: alias.toUpperCase() };
            });
          } catch (error) {
            // Auth and the chapter database cannot share one transaction. An
            // invitation may already be in flight; never delete an Auth user
            // here because it might have existed before this request.
            fail(503, "The invitation may have been sent, but the portal account was not saved. Contact the portal administrator before retrying.");
          }
          return json(res, 201, created);
        }
        const invited = validateRoster(input);
        const created = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          if (
            await db
              .prepare(
                "SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?",
              )
              .get(session.workspace, invited.provider, invited.subject)
          )
            fail(
              409,
              "This stable identity is already bound to a roster member.",
            );
          const id = randomUUID();
          await insertMember(session.workspace, {
            ...invited,
            id,
            role: "member",
          });
          await db
            .prepare("INSERT INTO identities VALUES (?,?,?,?)")
            .run(session.workspace, invited.provider, invited.subject, id);
          await audit(
            session.workspace,
            user.name,
            "roster.invite",
            id,
            `${invited.provider}; tier ${invited.tier}; credits ${invited.credits}`,
          );
          return await member(session.workspace, id);
        });
        return json(res, 201, { member: created });
      }
      const resetMember = path.match(/^\/api\/roster\/([^/]+)\/reset-password$/);
      if (resetMember && req.method === "POST" && production && authMode === "chapter") {
        chair(user);
        if (!chapterEmailReady) fail(503, "Email resets are not available yet. Members can use their recovery key.");
        const target = await member(session.workspace, resetMember[1]);
        if (!target?.active || target.role !== "member") fail(404, "Active member not found.");
        const linked = await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider=? AND member_id=?")
          .get(session.workspace, "supabase", target.id);
        if (!linked) fail(409, "This member has no chapter login yet.");
        await sendPasswordReset(env, target.email, `${origin}/account/reset`);
        await audit(session.workspace, user.name, "account.reset_requested", target.id);
        return json(res, 200, { message: "Password reset email requested." });
      }
      const deactivate = path.match(/^\/api\/roster\/([^/]+)\/deactivate$/);
      if (deactivate && req.method === "POST") {
        chair(user);
        const target = await member(session.workspace, deactivate[1]);
        if (!target) fail(404, "Roster member not found.");
        if (target.id === user.id || target.role === "chair")
          fail(
            422,
            "The Scholarship Chair cannot be deactivated through this action.",
          );
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          await db
            .prepare("UPDATE members SET active=0 WHERE workspace=? AND id=?")
            .run(session.workspace, target.id);
          await advanceCanvasGeneration(session.workspace, target.id);
          await db
            .prepare(
              "DELETE FROM transactions WHERE session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)",
            )
            .run(session.workspace, target.id);
          await db
            .prepare("DELETE FROM sessions WHERE workspace=? AND member_id=?")
            .run(session.workspace, target.id);
          await db
            .prepare(
              "DELETE FROM integrations WHERE workspace=? AND member_id=?",
            )
            .run(session.workspace, target.id);
          await audit(
            session.workspace,
            user.name,
            "roster.deactivate",
            target.id,
          );
        });
        return json(res, 200, {
          member: await member(session.workspace, target.id),
        });
      }
      if (path === "/api/audit" && req.method === "GET") {
        chair(user);
        return json(res, 200, {
          events: await db
            .prepare(
              "SELECT id,at,actor,action,subject,detail FROM audit WHERE workspace=? ORDER BY id DESC LIMIT 200",
            )
            .all(session.workspace),
        });
      }
      if (path === "/api/submissions" && req.method === "GET") {
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          submissions: await Promise.all(
            state.submissions
              .filter((s) => user.role === "chair" || s.owner === user.id)
              .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
              .map(async (s) => ({
                ...s,
                memberName:
                  (await member(session.workspace, s.owner))?.name ||
                  "Former member",
              })),
          ),
        });
      }
      if (path === "/api/submissions" && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        const evidenceId = input.evidenceId || input.evidence;
        let evidence;
        if (!production && evidenceId === "sample") evidence = "sample";
        else if (
          !evidenceId ||
          evidenceId === "sample" ||
          evidenceId === "canvas"
        )
          fail(
            422,
            "Upload your evidence file or import a verified Canvas assignment first.",
          );
        else evidence = (await getUpload(evidenceId, session, user, true)).id;
        const result = await mutate(session, user, async (state) => {
          academicGuard(state, generation);
          if (evidence !== "sample")
            await getUpload(evidence, session, user, true);
          const item = newSubmission(
            claim(input, state, user, evidence),
            user,
            {
              source: evidence === "sample" ? "manual-sample" : "upload",
              ...(evidence === "sample" ? {} : { evidenceId: evidence }),
            },
          );
          state.submissions.push(item);
          await audit(
            session.workspace,
            user.name,
            "submission.create",
            item.id,
          );
          return { submission: item, points: totals(state, user, policyDay()) };
        });
        return json(res, 201, result);
      }
      const submissionRoute = path.match(
        /^\/api\/submissions\/([^/]+)(?:\/(review|evidence))?$/,
      );
      if (submissionRoute) {
        const state = await stateOf(session.workspace);
        const item = ownSubmission(state, user, submissionRoute[1]);
        if (!submissionRoute[2] && req.method === "GET")
          return json(res, 200, {
            submission: {
              ...item,
              memberName:
                (await member(session.workspace, item.owner))?.name ||
                "Former member",
            },
          });
        if (submissionRoute[2] === "evidence" && req.method === "GET") {
          await audit(
            session.workspace,
            user.name,
            "evidence.view",
            item.id,
            user.role,
          );
          if (item.evidenceId) {
            const upload = await getUpload(item.evidenceId, session, user);
            return json(res, 200, {
              evidence: {
                sample: false,
                submission: item.id,
                ...uploadMeta(upload),
                downloadUrl: `/api/uploads/${upload.id}`,
                verification:
                  "Uploaded documentation requires Scholarship Chair review.",
              },
            });
          }
          if (item.source === "canvas")
            return json(res, 200, {
              evidence: {
                sample: false,
                source: "canvas",
                submission: item.id,
                title: item.title,
                course: item.course,
                date: item.date,
                grade: item.provenance.rawGradePercent ?? item.grade,
                ...item.provenance,
                verification:
                  "Retrieved server-side from the member’s connected Canvas account. Category and eligibility require Chair review.",
              },
            });
          if (production) fail(404, "Evidence record not found.");
          return json(res, 200, {
            evidence: {
              sample: true,
              submission: item.id,
              title: item.title,
              activity: activities.find((a) => a.id === item.activity)?.name,
              course: item.course,
              date: item.date,
              grade: item.grade,
              hours: item.quantity,
              note: item.note,
              verification:
                "Fictional sample record; no academic documentation has been uploaded.",
            },
          });
        }
        if (submissionRoute[2] === "review" && req.method === "POST") {
          chair(user);
          const generation = await academicSnapshot(session, requestGeneration);
          const result = await mutate(session, user, async (state) => {
            academicGuard(state, generation);
            const item = ownSubmission(state, user, submissionRoute[1]);
            if (item.status !== "pending")
              fail(409, "This submission has already been reviewed.");
            if (!["approved", "denied"].includes(input.decision))
              fail(422, "Choose approve or deny.");
            const note =
              typeof input.note === "string" ? input.note.trim() : "";
            if (note.length > 1000)
              fail(422, "Keep the review note under 1,000 characters.");
            if (
              input.decision === "approved" &&
              (!Number.isInteger(input.points) ||
                input.points < 0 ||
                input.points > 100)
            )
              fail(422, "Award a whole number of points from 0 to 100.");
            if (
              (input.decision === "denied" || input.points !== item.estimate) &&
              note.length < 5
            )
              fail(
                422,
                "Explain the denial or point adjustment in a review note.",
              );
            item.status = input.decision;
            item.awarded = input.decision === "approved" ? input.points : 0;
            item.reviewNote = note;
            item.reviewedAt = now();
            item.reviewer = user.name;
            item.history.push({
              event:
                item.status === "approved"
                  ? `Approved · ${item.awarded} points`
                  : "Denied",
              by: user.name,
              at: item.reviewedAt,
              note,
            });
            await audit(
              session.workspace,
              user.name,
              `submission.${input.decision}`,
              item.id,
              `${item.awarded} points; ${note}`,
            );
            return {
              submission: item,
              points: totals(
                state,
                await member(session.workspace, item.owner),
                policyDay(),
              ),
            };
          });
          return json(res, 200, result);
        }
      }
      if (path === "/api/demo/reset" && req.method === "POST" && !production) {
        await mutate(session, user, async (state) => {
          academicGuard(state);
          state.submissions = seed().submissions;
          await audit(session.workspace, user.name, "demo.reset");
        });
        return json(res, 200, { reset: true });
      }
      if (path === "/api/export" && req.method === "GET") {
        chair(user);
        const state = await stateOf(session.workspace);
        const quote = (v) => {
          const s = String(v ?? "");
          return `"${(/^\s*[=+@\-]|^[\t\r\n]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
        };
        const rows = [
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
          ...(await Promise.all(
            state.submissions.map(async (s) => [
              s.id,
              (await member(session.workspace, s.owner))?.name ||
                "Former member",
              s.activity,
              s.title,
              s.date,
              s.status,
              s.awarded,
              s.reviewNote,
            ]),
          )),
        ];
        await audit(
          session.workspace,
          user.name,
          "submissions.export",
          "",
          `${state.submissions.length} records`,
        );
        const csv = rows.map((row) => row.map(quote).join(",")).join("\r\n");
        if (Buffer.byteLength(csv) > 4 * 1024 * 1024)
          fail(413, "Report is too large; contact the portal administrator.");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="scholarship-submissions.csv"',
        });
        return res.end(csv);
      }
      fail(404, "API endpoint not found.");
    }
    if (path === "/demo" && req.method === "GET") {
      res.writeHead(302, { Location: "/demo/" });
      return res.end();
    }
    if (["/demo/login", "/demo/login.html"].includes(path) && req.method === "GET") {
      const account = url.searchParams.get("account") === "demo-chair" ? "chair" : "member";
      res.writeHead(302, { Location: `/demo/?account=${account}` });
      return res.end();
    }
    const mapping = {
      "/": "index.html",
      "/index.html": "index.html",
      "/account/setup": "index.html",
      "/account/reset": "index.html",
      "/style.css": "style.css",
      "/theme.css": "theme.css",
      "/theme.js": "theme.js",
      "/ato-logo.png": "ato-logo.png",
      "/app.js": "app.js",
      "/demo/": "demo/index.html",
      "/demo/index.html": "demo/index.html",
      "/demo/style.css": "demo/style.css",
      "/demo/app.js": "demo/app.js",
      "/demo/demo-worker.js": "demo/demo-worker.js",
      "/demo/demo-domain.mjs": "demo/demo-domain.mjs",
      "/demo/demo-canvas.mjs": "demo/demo-canvas.mjs",
    };
    if (req.method !== "GET" || !mapping[path]) fail(404, "Not found.");
    const file = mapping[path];
    const contents = await readFile(resolve(root, "web", file));
    res.writeHead(200, {
      "Content-Type": {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".png": "image/png",
      }[extname(file)],
    });
    res.end(contents);
  } catch (error) {
    const canvasError =
      typeof error.code === "string" && error.code.startsWith("CANVAS_");
    const status =
      error.status ||
      (canvasError ? (error.code.includes("CONFIG") ? 503 : 502) : 500);
    if (!res.headersSent)
      json(res, status, {
        error:
          error.status || canvasError
            ? error.message
            : "The portal could not complete this request.",
      });
    else res.end();
    // Do not log request URLs, credentials, submitted records or provider error bodies.
    if (status >= 500) console.error(`Portal request failed (${status}).`);
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, env.HOST || "127.0.0.1", () =>
  console.log(`ATO scholarship private: ${origin} (${mode})`),
);
function shutdown() {
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
