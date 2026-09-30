import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export const SEMESTER_RESET_CONFIRMATION = 'DELETE SEMESTER';
export const UPLOAD_GRANT_DRAIN_MS = (2 * 60 * 60 + 5 * 60) * 1000;
const LEASE_MS = 120_000;
const RETRY_MS = 30_000;
const PREVIEW_MS = 10 * 60 * 1000;
const FINALIZER_DRAIN_MS = 5 * 60 * 1000;

export class SemesterError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'SemesterError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status, message) => { throw new SemesterError(code, status, message); };
const timestamp = clock => typeof clock === 'function' ? clock() : clock;
const iso = value => new Date(value).toISOString();

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateSemesterSettings(input) {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' ||
      !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) {
    fail('SEMESTER_SETTINGS', 422, 'Enter a semester name of at most 80 characters.');
  }
  if (![input.startDate, input.targetDate, input.endDate].every(date) ||
      !Array.isArray(input.checkpointDates) || input.checkpointDates.length !== 3 ||
      !input.checkpointDates.every(date)) {
    fail('SEMESTER_SETTINGS', 422, 'Set a semester start, three checkpoints, final target and submission closing date.');
  }
  const ordered = [input.startDate, ...input.checkpointDates, input.targetDate];
  if (ordered.some((value, index) => index > 0 && value <= ordered[index - 1]) || input.endDate < input.targetDate) {
    fail('SEMESTER_SETTINGS', 422, 'Semester dates must increase from start through all checkpoints; submissions close on or after the final target.');
  }
  return { name: input.name.trim(), startDate: input.startDate, targetDate: input.targetDate,
    endDate: input.endDate, checkpointDates: [...input.checkpointDates] };
}

export function assertAcademicWritesAllowed(state) {
  if (state?.semesterReset?.status === 'purging') {
    fail('SEMESTER_PURGING', 423, 'Semester cleanup is in progress. Academic submissions will reopen after evidence deletion is verified.');
  }
}

export function semesterResetStatus(state, clock = Date.now) {
  const job = state?.semesterReset;
  if (!job) return { status: 'idle', phase: 'idle', count: 0, deleted: 0, remaining: 0, nextAttemptAt: null,
    semester: state?.semester ?? null };
  const now = timestamp(clock);
  const remaining = job.status === 'completed' ? [] : job.objects.filter(object => !object.deletedAt);
  const held = job.lease && job.lease.expiresAt > now;
  const due = remaining.some(object => object.notBefore <= now);
  const retry = held ? job.lease.expiresAt : due ? now : remaining.length ? Math.min(...remaining.map(object => object.notBefore)) : null;
  return { id: job.id, status: job.status,
    phase: job.status === 'completed' ? 'completed' : held ? 'working' : due ? 'purging' : 'waiting',
    count: job.count, deleted: job.count - remaining.length, remaining: remaining.length,
    nextAttemptAt: retry === null ? null : iso(retry), startedAt: job.startedAt,
    completedAt: job.completedAt ?? null, nextSemester: job.nextSemester,
    semester: state.semester ?? null, counts: job.counts,
    lastError: job.lastError ? 'Evidence deletion is incomplete. Resume cleanup to retry.' : null };
}

async function chapter(db, workspace, lock = false) {
  const row = await db.prepare(`SELECT data FROM chapters WHERE workspace=?${lock ? ' FOR UPDATE' : ''}`).get(workspace);
  if (!row) fail('SEMESTER_WORKSPACE', 404, 'Chapter workspace was not found.');
  try {
    const state = JSON.parse(row.data);
    if (!state || typeof state !== 'object' || !Array.isArray(state.submissions)) throw Error();
    return state;
  } catch { fail('SEMESTER_STATE', 503, 'Chapter semester data is unavailable.'); }
}

async function save(db, workspace, state) {
  await db.prepare('UPDATE chapters SET data=? WHERE workspace=?').run(JSON.stringify(state), workspace);
}

async function uploads(db, workspace) {
  return db.prepare('SELECT id,backend,filename,final_path,created_at FROM uploads WHERE workspace=?').all(workspace);
}

function deletionPlan(rows, now) {
  const objects = new Map();
  for (const row of rows) {
    const backend = row.backend || 'local';
    if (!['local', 'supabase'].includes(backend)) fail('SEMESTER_STORAGE', 503, 'An evidence storage reference needs administrator review before reset.');
    for (const path of [row.filename, row.final_path].filter(Boolean)) {
      const localValid = /^[a-f0-9-]{36}\.bin$/i.test(path);
      const hostedValid = /^(quarantine|evidence)\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,80}\/[a-f0-9-]{36}$/i.test(path);
      if (typeof path !== 'string' || (backend === 'local' ? !localValid : !hostedValid)) {
        fail('SEMESTER_STORAGE', 503, 'An evidence storage reference needs administrator review before reset.');
      }
      const created = Date.parse(row.created_at);
      // Include ready uploads too: their previously issued quarantine grant can still be reused.
      const notBefore = backend !== 'supabase' ? now : path.startsWith('quarantine/') ?
        Math.max(now + FINALIZER_DRAIN_MS, (Number.isFinite(created) ? Math.max(created, 0) : now) + UPLOAD_GRANT_DRAIN_MS) :
        now + FINALIZER_DRAIN_MS;
      const key = `${backend}:${path}`;
      const existing = objects.get(key);
      if (existing) existing.notBefore = Math.max(existing.notBefore, notBefore);
      else objects.set(key, { backend, path, notBefore, deletedAt: null, attempts: 0 });
    }
  }
  return [...objects.values()];
}

async function countsFor(db, workspace, state, rows, now) {
  const accounts = await db.prepare('SELECT id FROM members WHERE workspace=?').all(workspace);
  return { submissions: state.submissions.length, evidence: rows.length, accounts: accounts.length,
    objects: deletionPlan(rows, now).length };
}

function snapshot(state, rows) {
  return createHash('sha256').update(JSON.stringify({ generation: state.semesterGeneration,
    semester: state.semester, submissions: state.submissions, pointAdjustments: state.pointAdjustments,
    uploads: [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  })).digest('hex');
}

function equalToken(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string' || first.length !== second.length || first.length > 100) return false;
  const firstBytes = Buffer.from(first), secondBytes = Buffer.from(second);
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}

export async function previewSemesterReset({ db, workspace, now = Date.now, authorize = async () => {} }) {
  return db.transaction(async () => {
    const state = await chapter(db, workspace, true);
    await authorize();
    const rows = await uploads(db, workspace);
    const time = timestamp(now);
    const counts = await countsFor(db, workspace, state, rows, time);
    let previewToken = null;
    if (state.semesterReset?.status !== 'purging') {
      previewToken = randomUUID();
      state.semesterPreview = { token: previewToken, expiresAt: time + PREVIEW_MS, snapshot: snapshot(state, rows) };
      await save(db, workspace, state);
    }
    return { semester: state.semester ?? null, counts, confirmation: SEMESTER_RESET_CONFIRMATION,
      previewToken, previewExpiresAt: previewToken ? iso(time + PREVIEW_MS) : null,
      reset: semesterResetStatus(state, time), backupNotice: 'This removes live application records and evidence. Separately retained backups expire under their own retention policy.' };
  });
}

function complete(state, job, now) {
  job.status = 'completed';
  job.completedAt = iso(now);
  job.objects = [];
  job.lease = null;
  job.lastError = null;
  state.semester = job.nextSemester;
}

export async function startSemesterReset({ db, workspace, actor, confirm, semester, previewToken, now = Date.now, authorize = async () => {} }) {
  if (confirm !== SEMESTER_RESET_CONFIRMATION) fail('SEMESTER_CONFIRMATION', 422, `Type ${SEMESTER_RESET_CONFIRMATION} to permanently reset this semester.`);
  const nextSemester = validateSemesterSettings(semester);
  return db.transaction(async () => {
    const state = await chapter(db, workspace, true);
    await authorize();
    assertAcademicWritesAllowed(state);
    const rows = await uploads(db, workspace);
    const time = timestamp(now);
    const preview = state.semesterPreview;
    if (!preview || !equalToken(previewToken, preview.token) || preview.expiresAt <= time || preview.snapshot !== snapshot(state, rows)) {
      fail('SEMESTER_PREVIEW_STALE', 409, 'The semester preview changed or expired. Refresh the preview and confirm the updated counts.');
    }
    const counts = await countsFor(db, workspace, state, rows, time);
    const objects = deletionPlan(rows, time);
    const job = { id: randomUUID(), status: 'purging', startedAt: iso(time), nextSemester,
      counts, count: objects.length, objects, lease: null, lastError: null };
    state.submissions = [];
    delete state.pointAdjustments;
    // Pre-invitation tier decisions belong to the old semester. Member
    // accounts remain; the Chair reviews their tiers for the new semester.
    delete state.tierAssignments;
    delete state.memberProfiles;
    delete state.creditRequests;
    delete state.profilePictures;
    delete state.checkpointQuotas;
    delete state.checkpointQuotaRevision;
    state.semesterGeneration = randomUUID();
    delete state.semesterPreview;
    state.semesterReset = job;
    if (!objects.length) complete(state, job, time);
    // The deletion manifest is stored in the same transaction that withdraws access.
    await save(db, workspace, state);
    await db.prepare('DELETE FROM uploads WHERE workspace=?').run(workspace);
    await db.prepare("DELETE FROM audit WHERE workspace=? AND (action LIKE 'submission.%' OR action LIKE 'evidence.%' OR action='canvas.import' OR action='points.adjustment')").run(workspace);
    await db.prepare('INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)').run(
      workspace, iso(time), String(actor || 'Scholarship Chair').slice(0, 160), 'semester.reset.start', job.id,
      JSON.stringify({ counts, nextSemester: nextSemester.name }),
    );
    return semesterResetStatus(state, time);
  });
}

// One object per call bounds serverless work. Failed/terminated calls are retried from durable state.
// deleteObject must only return {deleted:true} after confirming the exact object no longer exists.
export async function resumeSemesterReset({ db, workspace, deleteObject, now = Date.now, authorize = async () => {} }) {
  if (typeof deleteObject !== 'function') fail('SEMESTER_STORAGE', 503, 'Evidence deletion is unavailable.');
  const claim = await db.transaction(async () => {
    const state = await chapter(db, workspace, true);
    await authorize();
    const job = state.semesterReset;
    const time = timestamp(now);
    if (!job || job.status !== 'purging') return { result: semesterResetStatus(state, time) };
    if (job.lease?.expiresAt > time) return { result: semesterResetStatus(state, time) };
    const object = job.objects.find(item => !item.deletedAt && item.notBefore <= time);
    if (!object) return { result: semesterResetStatus(state, time) };
    const token = randomUUID();
    job.lease = { token, expiresAt: time + LEASE_MS };
    await save(db, workspace, state);
    return { token, jobId: job.id, object: { backend: object.backend, path: object.path } };
  });
  if (claim.result) return claim.result;
  let deleted = false;
  try { deleted = (await deleteObject(claim.object))?.deleted === true; } catch {}
  return db.transaction(async () => {
    const state = await chapter(db, workspace, true);
    await authorize();
    const job = state.semesterReset;
    const time = timestamp(now);
    if (!job || job.id !== claim.jobId || job.lease?.token !== claim.token) return semesterResetStatus(state, time);
    const object = job.objects.find(item => item.backend === claim.object.backend && item.path === claim.object.path);
    if (!object) fail('SEMESTER_STATE', 503, 'Semester deletion progress is unavailable.');
    object.attempts++;
    if (deleted) {
      object.deletedAt = iso(time);
      job.lastError = null;
    } else {
      object.notBefore = Math.max(object.notBefore, time + RETRY_MS);
      job.lastError = true;
    }
    job.lease = null;
    if (job.objects.every(item => item.deletedAt)) {
      complete(state, job, time);
      await db.prepare('INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)').run(
        workspace, iso(time), 'System', 'semester.reset.complete', job.id, 'Live academic records and planned evidence objects deleted.',
      );
    }
    await save(db, workspace, state);
    return semesterResetStatus(state, time);
  });
}
