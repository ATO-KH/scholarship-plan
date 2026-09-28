import http from "node:http";
import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
  sealTokens,
  openTokens,
} from "./canvas.mjs";

const env = process.env;
const root = resolve(import.meta.dirname, "..");
const mode = env.APP_MODE || "demo";
if (!["demo", "production"].includes(mode))
  throw Error("APP_MODE must be demo or production.");
const production = mode === "production";
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
await mkdir(filesDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
const databaseFile = resolve(dataDir, "chapter.sqlite");
const db = new DatabaseSync(databaseFile);
await chmod(databaseFile, 0o600);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS chapters (workspace TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members (workspace TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('chair','member')), tier INTEGER, credits REAL, active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(workspace,id));
  CREATE TABLE IF NOT EXISTS identities (workspace TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, member_id TEXT NOT NULL,
    PRIMARY KEY(workspace,provider,subject), FOREIGN KEY(workspace,member_id) REFERENCES members(workspace,id));
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, member_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT, data TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS integrations (workspace TEXT NOT NULL, member_id TEXT NOT NULL, data TEXT NOT NULL, revision TEXT NOT NULL,
    PRIMARY KEY(workspace,member_id));
  CREATE TABLE IF NOT EXISTS canvas_generations (workspace TEXT NOT NULL, member_id TEXT NOT NULL, generation TEXT NOT NULL,
    PRIMARY KEY(workspace,member_id));
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, at TEXT NOT NULL,
    actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
  CREATE INDEX IF NOT EXISTS audit_workspace ON audit(workspace,id);`);
db.prepare("INSERT OR IGNORE INTO chapters VALUES (?,?)").run(
  "chapter",
  JSON.stringify({ submissions: [] }),
);

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
const sessionCookie = production ? "__Host-ato_session" : "ato_session";
const identityCookie = production ? "__Host-ato_identity" : "ato_identity";
const SESSION_LIFETIME = 8 * 60 * 60 * 1000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
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
function atomic(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function audit(workspace, actor, action, subject = "", detail = "") {
  db.prepare(
    "INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)",
  ).run(workspace, now(), actor || "system", action, subject, detail);
}
function member(workspace, id) {
  const row = db
    .prepare("SELECT * FROM members WHERE workspace=? AND id=?")
    .get(workspace, id);
  if (!row) return null;
  const checkpoint =
    checkpoints.find((c) => c.date >= policyDay()) || checkpoints.at(-1);
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
function listMembers(workspace) {
  return db
    .prepare("SELECT id FROM members WHERE workspace=? ORDER BY name")
    .all(workspace)
    .map((row) => member(workspace, row.id));
}
function insertMember(workspace, m) {
  db.prepare(
    "INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES (?,?,?,?,?,?,?,1)",
  ).run(
    workspace,
    m.id,
    m.name,
    m.email,
    m.role,
    m.tier ?? null,
    m.credits ?? null,
  );
}
function stateOf(workspace) {
  return JSON.parse(
    db.prepare("SELECT data FROM chapters WHERE workspace=?").get(workspace)
      .data,
  );
}
function currentSession(req) {
  const raw = getCookie(req, sessionCookie);
  if (!raw) return null;
  return (
    db
      .prepare("SELECT * FROM sessions WHERE id=? AND expires>?")
      .get(sha(raw), Date.now()) || null
  );
}
function requireSession(req) {
  const session = currentSession(req);
  const user = session && member(session.workspace, session.member_id);
  if (!session || !user?.active)
    fail(401, "Sign in to an active chapter account.");
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
function issueSession(workspace, userId, previousId = null) {
  if (previousId) db.prepare("DELETE FROM sessions WHERE id=?").run(previousId);
  const raw = token();
  const session = {
    id: sha(raw),
    workspace,
    member_id: userId,
    csrf: token(),
    expires: Date.now() + SESSION_LIFETIME,
  };
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(
    session.id,
    workspace,
    userId,
    session.csrf,
    session.expires,
  );
  return { session, cookie: cookie(sessionCookie, raw) };
}
function cleanup() {
  db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
  db.prepare("DELETE FROM transactions WHERE expires<=?").run(Date.now());
}
function mutate(session, user, fn) {
  return atomic(() => {
    const fresh = db
      .prepare("SELECT id FROM sessions WHERE id=? AND expires>?")
      .get(session.id, Date.now());
    if (!fresh || !member(session.workspace, user.id)?.active)
      fail(401, "Your account session is no longer active.");
    const state = stateOf(session.workspace);
    const result = fn(state);
    db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(
      JSON.stringify(state),
      session.workspace,
    );
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
function connection(session) {
  return db
    .prepare("SELECT * FROM integrations WHERE workspace=? AND member_id=?")
    .get(session.workspace, session.member_id);
}
function advanceCanvasGeneration(workspace, userId) {
  const generation = randomUUID();
  db.prepare("INSERT OR REPLACE INTO canvas_generations VALUES (?,?,?)").run(
    workspace,
    userId,
    generation,
  );
  db.prepare(
    "DELETE FROM transactions WHERE kind='canvas' AND session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)",
  ).run(workspace, userId);
  return generation;
}
function sessionPayload(session, user) {
  return {
    user,
    csrfToken: session.csrf,
    mode,
    today: policyDay(),
    canvasConnected: !!connection(session),
  };
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(value));
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
  if (production && endDate && policyDay() > endDate)
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
function getUpload(id, session, user, ownerOnly = false) {
  const upload =
    typeof id === "string" &&
    db
      .prepare("SELECT * FROM uploads WHERE id=? AND workspace=?")
      .get(id, session.workspace);
  if (
    !upload ||
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
    !["microsoft", "google"].includes(input.provider) ||
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
const canvasLocks = new Map();
async function liveAssignments(session, user) {
  if (!canvasConfigured())
    fail(503, "Canvas is not configured. Contact the portal administrator.");
  const lockKey = `${session.workspace}:${user.id}`;
  const previous = canvasLocks.get(lockKey) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const stored = connection(session);
      if (!stored) fail(409, "Connect your Canvas account first.");
      const assignments = await fetchCanvasAssignments({
        env,
        tokens: openTokens(stored.data, env),
        redirectUri: `${origin}/auth/canvas/callback`,
        onTokenRefresh: (tokens) => {
          if (!member(session.workspace, user.id)?.active)
            fail(401, "Your account is no longer active.");
          const changed = db
            .prepare(
              "UPDATE integrations SET data=? WHERE workspace=? AND member_id=? AND revision=?",
            )
            .run(
              sealTokens(tokens, env),
              session.workspace,
              user.id,
              stored.revision,
            );
          if (!changed.changes)
            fail(409, "Canvas connection changed. Start again.");
        },
      });
      if (
        connection(session)?.revision !== stored.revision ||
        !member(session.workspace, user.id)?.active
      )
        fail(409, "Canvas connection changed. Start again.");
      return assignments;
    });
  canvasLocks.set(lockKey, task);
  try {
    return await task;
  } finally {
    if (canvasLocks.get(lockKey) === task) canvasLocks.delete(lockKey);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  if (production)
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  try {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (!["GET", "POST"].includes(req.method)) fail(405, "Method not allowed.");
    if (path === "/api/config" && req.method === "GET")
      return json(res, 200, {
        mode,
        providers: identityProviders(env),
        canvasConfigured: canvasConfigured(),
        semester: { targetDate, endDate, timeZone: "America/New_York" },
      });
    if (production && path.startsWith("/api/demo/")) fail(404, "Not found.");
    if (path === "/api/demo/session" && req.method === "POST" && !production) {
      requireOrigin(req);
      if (req.headers["x-ato-demo"] !== "1")
        fail(403, "The demo request header is required.");
      const input = await readBody(req);
      let session = currentSession(req);
      if (session) csrf(req, session);
      const persona = input.persona || session?.member_id || "alex";
      if (!demoMembers.some((m) => m.id === persona))
        fail(422, "Unknown demo persona.");
      cleanup();
      let workspace = session?.workspace;
      const issued = atomic(() => {
        if (!workspace) {
          workspace = `demo-${randomUUID()}`;
          db.prepare("INSERT INTO chapters VALUES (?,?)").run(
            workspace,
            JSON.stringify(seed()),
          );
          for (const m of demoMembers) insertMember(workspace, m);
        }
        return issueSession(workspace, persona, session?.id);
      });
      return json(
        res,
        200,
        sessionPayload(issued.session, member(workspace, persona)),
        { "Set-Cookie": issued.cookie },
      );
    }

    const identityRoute = path.match(
      /^\/auth\/(microsoft|google)(\/callback)?$/,
    );
    if (identityRoute && req.method === "GET") {
      if (!production)
        fail(
          403,
          "Organization sign-in is disabled in the isolated demonstration.",
        );
      const provider = identityRoute[1];
      const redirectUri = `${origin}/auth/${provider}/callback`;
      if (!identityRoute[2]) {
        cleanup();
        const flow = startIdentityFlow(provider, { env, redirectUri });
        const browserToken = token();
        db.prepare("INSERT INTO transactions VALUES (?,?,?,?,?)").run(
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
        atomic(() => {
          const row = db
            .prepare(
              "SELECT * FROM transactions WHERE id=? AND kind=? AND expires>?",
            )
            .get(sha(browserToken), "identity", Date.now());
          db.prepare("DELETE FROM transactions WHERE id=?").run(
            sha(browserToken),
          );
          return row;
        });
      res.setHeader("Set-Cookie", cookie(identityCookie, "", 0));
      if (!txn || JSON.parse(txn.data).provider !== provider)
        fail(400, "Sign-in expired. Please start again.");
      const identity = await completeIdentityFlow({
        transaction: JSON.parse(txn.data),
        callbackUrl: url.href,
        env,
        redirectUri,
      });
      const issued = atomic(() => {
        let binding = db
          .prepare(
            "SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?",
          )
          .get("chapter", identity.provider, identity.subject);
        if (
          !binding &&
          env.BOOTSTRAP_PROVIDER === identity.provider &&
          equal(env.BOOTSTRAP_SUBJECT, identity.subject) &&
          !db
            .prepare(
              "SELECT id FROM members WHERE workspace='chapter' AND role='chair'",
            )
            .get()
        ) {
          const id = randomUUID();
          insertMember("chapter", {
            id,
            name: env.BOOTSTRAP_NAME?.trim().slice(0, 100) || identity.name,
            email: env.BOOTSTRAP_EMAIL?.trim().slice(0, 254) || identity.email,
            role: "chair",
          });
          db.prepare("INSERT INTO identities VALUES (?,?,?,?)").run(
            "chapter",
            identity.provider,
            identity.subject,
            id,
          );
          audit(
            "chapter",
            identity.name,
            "chair.bootstrap",
            id,
            "Created from explicitly configured provider and stable subject.",
          );
          binding = { member_id: id };
        }
        const user = binding && member("chapter", binding.member_id);
        if (!user?.active)
          fail(
            403,
            "Your verified account is not on the active chapter roster. Ask the Scholarship Chair to add its stable identity.",
          );
        audit(
          "chapter",
          user.name,
          "session.login",
          user.id,
          identity.provider,
        );
        return issueSession("chapter", user.id, currentSession(req)?.id);
      });
      return redirect(res, "/", {
        "Set-Cookie": [cookie(identityCookie, "", 0), issued.cookie],
      });
    }

    if (path.startsWith("/auth/canvas") || path.startsWith("/api/")) {
      let { session, user } = requireSession(req);
      if (req.method === "POST") csrf(req, session);
      const input =
        req.method === "POST"
          ? await readBody(req, path === "/api/uploads" ? 7_100_000 : 30_000)
          : null;
      // Re-read after request-body or network waits so deactivation and session rotation win.
      ({ session, user } = requireSession(req));
      if (
        req.headers["x-ato-expected-user"] &&
        req.headers["x-ato-expected-user"] !== user.id
      )
        fail(
          409,
          "The account changed in another tab. Refresh before continuing.",
        );
      if (path === "/api/session" && req.method === "GET")
        return json(res, 200, sessionPayload(session, user));
      if (path === "/api/me" && req.method === "GET")
        return json(res, 200, { user, mode, today: policyDay() });
      if (path === "/api/logout" && req.method === "POST") {
        atomic(() => {
          db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
          db.prepare("DELETE FROM transactions WHERE session_id=?").run(
            session.id,
          );
          audit(session.workspace, user.name, "session.logout", user.id);
        });
        return json(
          res,
          200,
          { loggedOut: true },
          { "Set-Cookie": cookie(sessionCookie, "", 0) },
        );
      }
      if (path === "/api/rules" && req.method === "GET")
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
          checkpoints,
          semester: { targetDate, endDate, timeZone: "America/New_York" },
        });
      if (path === "/api/integrations" && req.method === "GET")
        return json(res, 200, {
          providers: identityProviders(env),
          canvas: {
            configured: canvasConfigured(),
            connected: !!connection(session),
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
        atomic(() => {
          const generation = advanceCanvasGeneration(
            session.workspace,
            user.id,
          );
          db.prepare(
            "INSERT OR REPLACE INTO transactions VALUES (?,?,?,?,?)",
          ).run(
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
        const txn = atomic(() => {
          const row = db
            .prepare(
              "SELECT * FROM transactions WHERE id=? AND kind=? AND session_id=? AND expires>?",
            )
            .get(`canvas:${session.id}`, "canvas", session.id, Date.now());
          db.prepare("DELETE FROM transactions WHERE id=?").run(
            `canvas:${session.id}`,
          );
          return row;
        });
        if (!txn) fail(400, "Canvas connection expired. Please start again.");
        const tokens = await completeCanvasFlow({
          transaction: JSON.parse(txn.data),
          callbackUrl: url.href,
          env,
          redirectUri: `${origin}/auth/canvas/callback`,
        });
        const fresh = requireSession(req);
        if (fresh.session.id !== session.id)
          fail(401, "Your account session changed. Reconnect Canvas.");
        atomic(() => {
          const current = db
            .prepare(
              "SELECT generation FROM canvas_generations WHERE workspace=? AND member_id=?",
            )
            .get(session.workspace, user.id);
          if (current?.generation !== JSON.parse(txn.data).generation)
            fail(409, "Canvas connection changed. Start again.");
          db.prepare(
            "INSERT OR REPLACE INTO integrations VALUES (?,?,?,?)",
          ).run(
            session.workspace,
            user.id,
            sealTokens(tokens, env),
            randomUUID(),
          );
          audit(
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
        atomic(() => {
          db.prepare(
            "DELETE FROM integrations WHERE workspace=? AND member_id=?",
          ).run(session.workspace, user.id);
          advanceCanvasGeneration(session.workspace, user.id);
          audit(
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
          ? await liveAssignments(session, user)
          : sampleAssignments(stateOf(session.workspace), user.id);
        requireSession(req);
        const state = stateOf(session.workspace);
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
        const assignments = production
          ? await liveAssignments(session, user)
          : canvasAssignments;
        const result = mutate(session, user, (state) => {
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
            audit(
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
      if (path === "/api/uploads" && req.method === "POST") {
        individual(user);
        const file = validUpload(input);
        const id = randomUUID();
        const filename = `${id}.bin`;
        await writeFile(resolve(filesDir, filename), file.bytes, {
          flag: "wx",
          mode: 0o600,
        });
        try {
          requireSession(req);
          atomic(() => {
            db.prepare("INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?)").run(
              id,
              session.workspace,
              user.id,
              file.name,
              file.mime,
              file.bytes.length,
              filename,
              now(),
            );
            audit(
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
        const upload = getUpload(uploadRoute[1], session, user);
        const bytes = await readFile(resolve(filesDir, upload.filename));
        requireSession(req);
        audit(
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
          ...totals(stateOf(session.workspace), user, policyDay()),
        });
      }
      if (path === "/api/members" && req.method === "GET") {
        chair(user);
        const state = stateOf(session.workspace);
        return json(res, 200, {
          members: listMembers(session.workspace)
            .filter((m) => m.role === "member")
            .map((m) => ({ ...m, ...totals(state, m, policyDay()) })),
        });
      }
      if (path === "/api/roster" && req.method === "GET") {
        chair(user);
        return json(res, 200, {
          members: listMembers(session.workspace).map((m) => ({
            ...m,
            identities: db
              .prepare(
                "SELECT provider,subject FROM identities WHERE workspace=? AND member_id=?",
              )
              .all(session.workspace, m.id),
          })),
        });
      }
      if (path === "/api/roster" && req.method === "POST") {
        chair(user);
        const invited = validateRoster(input);
        const created = atomic(() => {
          if (
            db
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
          insertMember(session.workspace, { ...invited, id, role: "member" });
          db.prepare("INSERT INTO identities VALUES (?,?,?,?)").run(
            session.workspace,
            invited.provider,
            invited.subject,
            id,
          );
          audit(
            session.workspace,
            user.name,
            "roster.invite",
            id,
            `${invited.provider}; tier ${invited.tier}; credits ${invited.credits}`,
          );
          return member(session.workspace, id);
        });
        return json(res, 201, { member: created });
      }
      const deactivate = path.match(/^\/api\/roster\/([^/]+)\/deactivate$/);
      if (deactivate && req.method === "POST") {
        chair(user);
        const target = member(session.workspace, deactivate[1]);
        if (!target) fail(404, "Roster member not found.");
        if (target.id === user.id || target.role === "chair")
          fail(
            422,
            "The Scholarship Chair cannot be deactivated through this action.",
          );
        atomic(() => {
          db.prepare(
            "UPDATE members SET active=0 WHERE workspace=? AND id=?",
          ).run(session.workspace, target.id);
          advanceCanvasGeneration(session.workspace, target.id);
          db.prepare(
            "DELETE FROM transactions WHERE session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)",
          ).run(session.workspace, target.id);
          db.prepare(
            "DELETE FROM sessions WHERE workspace=? AND member_id=?",
          ).run(session.workspace, target.id);
          db.prepare(
            "DELETE FROM integrations WHERE workspace=? AND member_id=?",
          ).run(session.workspace, target.id);
          audit(session.workspace, user.name, "roster.deactivate", target.id);
        });
        return json(res, 200, { member: member(session.workspace, target.id) });
      }
      if (path === "/api/audit" && req.method === "GET") {
        chair(user);
        return json(res, 200, {
          events: db
            .prepare(
              "SELECT id,at,actor,action,subject,detail FROM audit WHERE workspace=? ORDER BY id DESC LIMIT 200",
            )
            .all(session.workspace),
        });
      }
      if (path === "/api/submissions" && req.method === "GET") {
        const state = stateOf(session.workspace);
        return json(res, 200, {
          submissions: state.submissions
            .filter((s) => user.role === "chair" || s.owner === user.id)
            .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
            .map((s) => ({
              ...s,
              memberName:
                member(session.workspace, s.owner)?.name || "Former member",
            })),
        });
      }
      if (path === "/api/submissions" && req.method === "POST") {
        individual(user);
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
        else evidence = getUpload(evidenceId, session, user, true).id;
        const result = mutate(session, user, (state) => {
          const item = newSubmission(
            claim(input, state, user, evidence),
            user,
            {
              source: evidence === "sample" ? "manual-sample" : "upload",
              ...(evidence === "sample" ? {} : { evidenceId: evidence }),
            },
          );
          state.submissions.push(item);
          audit(session.workspace, user.name, "submission.create", item.id);
          return { submission: item, points: totals(state, user, policyDay()) };
        });
        return json(res, 201, result);
      }
      const submissionRoute = path.match(
        /^\/api\/submissions\/([^/]+)(?:\/(review|evidence))?$/,
      );
      if (submissionRoute) {
        const state = stateOf(session.workspace);
        const item = ownSubmission(state, user, submissionRoute[1]);
        if (!submissionRoute[2] && req.method === "GET")
          return json(res, 200, {
            submission: {
              ...item,
              memberName:
                member(session.workspace, item.owner)?.name || "Former member",
            },
          });
        if (submissionRoute[2] === "evidence" && req.method === "GET") {
          audit(
            session.workspace,
            user.name,
            "evidence.view",
            item.id,
            user.role,
          );
          if (item.evidenceId) {
            const upload = getUpload(item.evidenceId, session, user);
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
          const result = mutate(session, user, (state) => {
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
            audit(
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
                member(session.workspace, item.owner),
                policyDay(),
              ),
            };
          });
          return json(res, 200, result);
        }
      }
      if (path === "/api/demo/reset" && req.method === "POST" && !production) {
        mutate(session, user, (state) => {
          state.submissions = seed().submissions;
          audit(session.workspace, user.name, "demo.reset");
        });
        return json(res, 200, { reset: true });
      }
      if (path === "/api/export" && req.method === "GET") {
        chair(user);
        const state = stateOf(session.workspace);
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
          ...state.submissions.map((s) => [
            s.id,
            member(session.workspace, s.owner)?.name || "Former member",
            s.activity,
            s.title,
            s.date,
            s.status,
            s.awarded,
            s.reviewNote,
          ]),
        ];
        audit(
          session.workspace,
          user.name,
          "submissions.export",
          "",
          `${state.submissions.length} records`,
        );
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="scholarship-submissions.csv"',
        });
        return res.end(
          rows.map((row) => row.map(quote).join(",")).join("\r\n"),
        );
      }
      fail(404, "API endpoint not found.");
    }
    const mapping = {
      "/": "index.html",
      "/index.html": "index.html",
      "/style.css": "style.css",
      "/app.js": "app.js",
    };
    if (req.method !== "GET" || !mapping[path]) fail(404, "Not found.");
    const file = mapping[path];
    const contents = await readFile(resolve(root, "dist", file));
    res.writeHead(200, {
      "Content-Type": {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
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
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
