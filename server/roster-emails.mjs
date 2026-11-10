import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { invitationVersion } from './invitations.mjs';
import { beginAuthMutation, finishAuthMutation } from './auth-mutation.mjs';
import { clearRecoveryKey } from './recovery.mjs';

const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
import { rosterDirectory, rosterEmails } from './roster-directory.mjs';

export function emailCorrectionVersion(state, email, member = null, authUserId = null) {
  return createHash('sha256').update(JSON.stringify({ email, member: member && [member.id, member.email, Boolean(member.active), member.role],
    authUserId, invitation: invitationVersion(state.invitations?.[email], member?.id),
    entry: rosterDirectory(state).find(row => row.email === email), corrections: state.rosterEmailCorrections || {},
  })).digest('hex');
}

// Caller owns a short workspace transaction. No provider request or email is
// sent here. The next explicit invitation creates a fresh, proven identity;
// an existing provider account at the new address must never be adopted.
export async function correctInvitationEmail({ db, workspace, state, email, nextEmail, version, audit }) {
  if (typeof nextEmail !== 'string') fail(422, 'Enter the corrected email address.');
  nextEmail = nextEmail.trim().toLowerCase();
  if (nextEmail.length > 254 || !/^[^\s@,<>"()]+@[^\s@,<>"()]+\.[^\s@,<>"()]+$/.test(nextEmail) || nextEmail.endsWith('@pilot.invalid'))
    fail(422, 'Enter a valid email address.');
  if (nextEmail === email) fail(422, 'Enter a different email address.');
  const entry = rosterDirectory(state).find(row => row.email === email);
  if (!entry || !rosterEmails(state).includes(email)) fail(409, 'Refresh the roster and confirm this recipient is still eligible.');
  const target = await db.prepare('SELECT * FROM members WHERE workspace=? AND LOWER(email)=?').get(workspace, email);
  if (target && (target.role !== 'member' || !target.active)) fail(409, 'Only active member invitation addresses can be corrected.');
  const binding = target && await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='supabase' AND member_id=?").get(workspace, target.id);
  if (version !== emailCorrectionVersion(state, email, target, binding?.subject || null))
    fail(409, 'This recipient changed. Refresh invitations before correcting the email.');
  const record = state.invitations?.[email];
  if (record?.operation?.until > Date.now()) fail(409, 'An invitation is being processed. Wait for it to finish before correcting the email.');
  if (await db.prepare('SELECT id FROM members WHERE workspace=? AND LOWER(email)=?').get(workspace, nextEmail) ||
      state.invitations?.[nextEmail] || rosterDirectory(state).some(row => row.email === nextEmail) ||
      (state.roster?.directory || []).some(row => row.email === nextEmail && row.email !== entry.sourceEmail) ||
      Object.entries(state.rosterEmailCorrections || {}).some(([source, row]) => source !== (entry.sourceEmail || email) && (source === nextEmail || row.email === nextEmail)))
    fail(409, 'That address already belongs to another account or roster entry. No changes were saved.');
  const sourceEmail = entry.sourceEmail || email;
  const correctedAt = new Date().toISOString();
  state.rosterEmailCorrections ||= {};
  state.rosterEmailCorrections[sourceEmail] = { email: nextEmail, sourceName: entry.name, correctedAt };
  // A sheet already corrected to a prior destination starts a new source.
  for (const [source, correction] of Object.entries(state.rosterEmailCorrections)) {
    if (source !== sourceEmail && correction.email === email && !(state.roster?.emails || []).includes(source)) delete state.rosterEmailCorrections[source];
  }
  if (state.tierAssignments?.[email] !== undefined) {
    state.tierAssignments[nextEmail] = state.tierAssignments[email]; delete state.tierAssignments[email];
  }
  if (target) {
    const epoch = await beginAuthMutation(db, workspace, target.id);
    await clearRecoveryKey(db, workspace, target.id);
    await db.prepare("DELETE FROM identities WHERE workspace=? AND member_id=? AND provider='supabase'").run(workspace, target.id);
    await db.prepare('UPDATE members SET email=? WHERE workspace=? AND id=?').run(nextEmail, workspace, target.id);
    await finishAuthMutation(db, workspace, target.id, epoch);
  }
  if (record || target) {
    const aliases = target ? (await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='login' AND member_id=? ORDER BY subject").all(workspace, target.id)).map(row => row.subject) : [];
    const alias = record?.alias || aliases.find(value => /^kh-[a-f0-9]{10}$/.test(value)) || aliases[0] || `kh-${randomBytes(5).toString('hex')}`;
    state.invitations ||= {};
    state.invitations[nextEmail] = {
      email: nextEmail, name: target?.name || record.name, memberId: target?.id || record.memberId || randomUUID(),
      tier: target?.tier ?? record.tier, credits: target?.credits ?? record.credits,
      alias, badge: record?.badge || aliases.find(value => value !== alias) || '',
      authUserId: null, bound: false, status: 'failed', initialEmailEligible: true,
      requiresNewIdentity: true, provenance: randomBytes(32).toString('hex'),
      createdAt: correctedAt, updatedAt: correctedAt, emailCorrectedAt: correctedAt, emailCorrectedMember: Boolean(target),
      emailHistory: [...(record?.emailHistory || []), { email, correctedAt, previouslyAccepted: Boolean(record?.acceptedAt), authUserId: binding?.subject || record?.authUserId || null }],
    };
    delete state.invitations[email];
  }
  await audit('roster.email_corrected', target?.id || record?.memberId || '', `${email} -> ${nextEmail}; records retained; previous portal access revoked; fresh invitation required.`);
  return { email: nextEmail, memberId: target?.id || null, message: 'Email corrected. Points, classes, and history are preserved. Send a fresh invitation to verify the new address.' };
}
