import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };

export const submissionReviewVersion = (state, item) => hash([state.semesterGeneration || 'initial', item]);

// List records deliberately omit evidence, long histories and syllabus snapshots.
// The detail route remains the source for a review or evidence preview.
export function submissionPage(state, user, names, search = new URLSearchParams()) {
  const size = search.get('limit') ?? '200';
  if (!/^[1-9]\d{0,2}$/.test(size) || Number(size) > 500) fail(422, 'Choose a page size from 1 to 500.');
  const items = state.submissions.filter(item => user.role === 'chair' || item.owner === user.id)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id));
  const version = hash([state.semesterGeneration || 'initial', items]);
  let offset = 0;
  if (search.has('cursor')) {
    let cursor;
    try {
      const raw = search.get('cursor');
      if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) ||
          typeof cursor.version !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.version)) throw Error();
    } catch { fail(422, 'Invalid submission page. Refresh the list.'); }
    if (cursor.version !== version) fail(409, 'Submissions changed while loading. Refresh the list.');
    if (!Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length)
      fail(422, 'Invalid submission page. Refresh the list.');
    offset = cursor.offset;
  }
  const page = items.slice(offset, offset + Number(size));
  const next = offset + page.length;
  return {
    submissions: page.map(item => ({
      id: item.id, owner: item.owner, activity: item.activity, title: item.title,
      course: item.course, date: item.date, status: item.status, estimate: item.estimate,
      awarded: item.awarded, submittedAt: item.submittedAt, memberTier: item.memberTier,
      source: item.source, canvasAssignmentId: item.canvasAssignmentId, reviewNote: item.reviewNote,
      activitySnapshot: item.activitySnapshot ? { name: item.activitySnapshot.name } : undefined,
      memberName: names.get(item.owner) || 'Former member',
    })),
    total: items.length,
    nextCursor: next < items.length ? Buffer.from(JSON.stringify({ version, offset: next })).toString('base64url') : null,
  };
}
