import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const CHAIR_MFA_LIFETIME = 10 * 60 * 1000;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const keyFor = env => {
  // Separate purpose-specific key; provider secrets remain outside the database.
  const secret = env.APP_ENCRYPTION_KEY || env.SUPABASE_SECRET_KEY;
  if (typeof secret !== 'string' || secret.length < 32) fail(503, 'Chair verification is not configured.');
  return Buffer.from(hkdfSync('sha256', secret, env.SUPABASE_URL, 'ato-chair-mfa-preauth-v1', 32));
};
export function sealChairMfa(env, data) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor(env), iv);
  cipher.setAAD(Buffer.from('ato-chair-mfa-preauth-v1'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}
export function openChairMfa(env, value) {
  try {
    const [iv, tag, body, extra] = value.split('.');
    if (extra !== undefined) throw Error();
    const cipher = createDecipheriv('aes-256-gcm', keyFor(env), Buffer.from(iv, 'base64url'));
    cipher.setAAD(Buffer.from('ato-chair-mfa-preauth-v1'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8'));
  } catch { fail(401, 'Chair verification expired. Sign in again.'); }
}

async function request(env, path, accessToken, body, method = body ? 'POST' : 'GET') {
  let response;
  try {
    response = await fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { fail(503, 'Authenticator verification is unavailable. Try again shortly.'); }
  if (!response.ok) {
    if (response.status === 429) fail(429, 'Too many authenticator attempts. Wait before trying again.');
    if (response.status >= 500) fail(503, 'Authenticator verification is unavailable. Try again shortly.');
    return null;
  }
  return response.status === 204 ? {} : response.json();
}
export async function verifyChairPassword(env, email, password) {
  const result = await request(env, 'token?grant_type=password', null, { email, password });
  if (!result?.user?.id || !result.user.email_confirmed_at || !result.access_token) return null;
  return { id: result.user.id, email: result.user.email?.toLowerCase(), accessToken: result.access_token };
}
async function providerUser(env, accessToken, expectedId) {
  const user = await request(env, 'user', accessToken);
  if (!user?.id || user.id !== expectedId) fail(401, 'Chair verification expired. Sign in again.');
  return user;
}
async function verifyFactorToken(env, accessToken, identity, factorId, code) {
  const challenge = await request(env, `factors/${encodeURIComponent(factorId)}/challenge`, accessToken, {});
  if (!challenge?.id) fail(401, 'Authenticator setup changed. Sign in again or request a new reset link.');
  const verified = await request(env, `factors/${encodeURIComponent(factorId)}/verify`, accessToken, { challenge_id: challenge.id, code });
  if (!verified?.access_token) fail(422, 'That code was not accepted. Enter the current code from your authenticator.');
  // The remote user endpoint verifies the token before its assurance claims are read.
  const user = await providerUser(env, verified.access_token, identity.id);
  let claims;
  try { claims = JSON.parse(Buffer.from(verified.access_token.split('.')[1], 'base64url').toString('utf8')); }
  catch { fail(401, 'Authenticator verification could not be confirmed.'); }
  if (claims.aal !== 'aal2' || claims.sub !== user.id || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() ||
      user.email?.toLowerCase() !== identity.email ||
      !user.factors?.some(factor => factor.id === factorId && factor.status === 'verified' && factor.factor_type === 'totp'))
    fail(401, 'Authenticator verification could not be confirmed.');
  return verified.access_token;
}

// Email recovery authenticates the inbox at AAL1. Supabase requires an AAL2
// provider session to change a password once a factor has been verified. This
// produces no portal session and does not change or enroll any factor.
export async function verifyPasswordResetMfa(env, accessToken, identity, code) {
  const user = await providerUser(env, accessToken, identity.id);
  if (user.email?.toLowerCase() !== identity.email) fail(401, 'This account link has expired. Request a new one.');
  const verified = (user.factors || []).filter(factor => factor.status === 'verified');
  if (!verified.length) return { accessToken };
  const factor = verified.find(item => item.factor_type === 'totp');
  if (!factor) fail(409, 'This account uses an unsupported authenticator. Contact the portal operator to recover access.');
  if (code === undefined || code === '') return { mfaRequired: true };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail(422, 'Enter the six-digit code from your authenticator.');
  return { accessToken: await verifyFactorToken(env, accessToken, identity, factor.id, code) };
}
export async function startChairMfa(db, env, identity, memberId) {
  const provider = await providerUser(env, identity.accessToken, identity.id);
  const factors = provider.factors || [];
  let factor = factors.find(item => item.factor_type === 'totp' && item.status === 'verified');
  let enrollment;
  if (!factor) {
    // An interrupted setup has not enrolled a second factor. Clean only our own
    // abandoned TOTP entries, never a verified factor or another app's entry.
    for (const item of factors.filter(item => item.factor_type === 'totp' && item.status !== 'verified' && item.friendly_name === 'Scholarship Chair')) {
      if (!await request(env, `factors/${encodeURIComponent(item.id)}`, identity.accessToken, null, 'DELETE'))
        fail(503, 'Authenticator setup could not be restarted. Try again shortly.');
    }
    enrollment = await request(env, 'factors', identity.accessToken, { factor_type: 'totp', friendly_name: 'Scholarship Chair', issuer: 'ATO Kappa Eta' });
    if (!enrollment?.id || !enrollment.totp?.qr_code || !enrollment.totp?.secret)
      fail(503, 'Authenticator setup is unavailable. Contact the portal operator.');
    factor = enrollment;
  }
  const raw = token(), expires = Date.now() + CHAIR_MFA_LIFETIME;
  const data = { memberId, authUserId: identity.id, email: identity.email, accessToken: identity.accessToken,
    factorId: factor.id, csrf: token(), stage: enrollment ? 'enroll' : 'verify', attempts: 0,
    ...(enrollment ? { qrCode: enrollment.totp.qr_code, secret: enrollment.totp.secret } : {}) };
  await db.prepare("DELETE FROM transactions WHERE kind='chair_mfa_pending' AND session_id=?").run(memberId);
  await db.prepare('INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,?,?,?,?)')
    .run(hash(raw), 'chair_mfa_pending', memberId, sealChairMfa(env, data), expires);
  return { raw, id: hash(raw), data, expires };
}
export async function pendingChairMfa(db, env, raw) {
  if (!raw) fail(401, 'Sign in before verifying your authenticator.');
  const row = await db.prepare("SELECT * FROM transactions WHERE id=? AND kind='chair_mfa_pending' AND expires>? FOR UPDATE")
    .get(hash(raw), Date.now());
  if (!row) fail(401, 'Chair verification expired. Sign in again.');
  const data = openChairMfa(env, row.data);
  if (data.memberId !== row.session_id) fail(401, 'Chair verification expired. Sign in again.');
  return { id: row.id, data, expires: row.expires };
}
export function chairMfaPayload(pending) {
  return { mfaRequired: true, csrfToken: pending.data.csrf,
    mfa: { stage: pending.data.stage, expiresAt: new Date(pending.expires).toISOString(),
      ...(pending.data.stage === 'enroll' ? { qrCode: pending.data.qrCode, secret: pending.data.secret } : {}) } };
}
export async function verifyChairMfaCode(db, env, pending, code) {
  if (!/^\d{6}$/.test(code || '')) fail(422, 'Enter the six-digit code from your authenticator.');
  if (pending.data.attempts >= 5) fail(429, 'Too many attempts. Sign in again after waiting.');
  pending.data.attempts++;
  await db.prepare('UPDATE transactions SET data=? WHERE id=?')
    .run(sealChairMfa(env, pending.data), pending.id);
  // Return errors to let the enclosing transaction commit the attempt counter.
  try {
    await verifyFactorToken(env, pending.data.accessToken, { id: pending.data.authUserId, email: pending.data.email }, pending.data.factorId, code);
    return { verified: true };
  } catch (error) {
    return { error: { status: error.status || 503, message: error.status ? error.message : 'Authenticator verification is unavailable. Try again shortly.' } };
  }
}
export async function markChairMfaSession(db, session, userId) {
  await db.prepare('INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,?,?,?,?)')
    .run(hash(`chair-mfa-session:${session.id}`), 'chair_mfa_verified', session.id, JSON.stringify({ memberId: userId, verifiedAt: new Date().toISOString() }), session.expires);
}
export async function assertChairMfaSession(db, session, userId) {
  const row = await db.prepare("SELECT data FROM transactions WHERE id=? AND kind='chair_mfa_verified' AND session_id=? AND expires>?")
    .get(hash(`chair-mfa-session:${session.id}`), session.id, Date.now());
  if (!row || JSON.parse(row.data).memberId !== userId)
    fail(401, 'Sign in again to verify the Scholarship Chair authenticator.');
}

const authMutationId = (workspace, memberId) => hash(`auth-mutation:${workspace}:${memberId}`);
export async function authMutationVersion(db, workspace, memberId) {
  const row = await db.prepare("SELECT data FROM transactions WHERE id=? AND kind='auth_mutation'").get(authMutationId(workspace, memberId));
  const state = row ? JSON.parse(row.data) : { epoch: 'initial', busyUntil: 0 };
  if (state.busyUntil > Date.now()) fail(409, 'An account security update is in progress. Try signing in again shortly.');
  return state.epoch;
}
export async function assertAuthMutationVersion(db, workspace, memberId, expected) {
  if (await authMutationVersion(db, workspace, memberId) !== expected)
    fail(401, 'Account security changed during sign-in. Sign in again.');
}
// Caller holds the chapter lock in a committed transaction before calling the
// external password provider. Epochs remain after completion so in-flight old
// password attempts cannot issue fresh sessions after the reset.
export async function beginAuthMutation(db, workspace, memberId) {
  await authMutationVersion(db, workspace, memberId);
  const epoch = token();
  await db.prepare("INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,'auth_mutation',NULL,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires=excluded.expires")
    .run(authMutationId(workspace, memberId), JSON.stringify({ epoch, busyUntil: Date.now() + 120_000 }), 253402300799000);
  await db.prepare('DELETE FROM transactions WHERE session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)').run(workspace, memberId);
  await db.prepare('DELETE FROM sessions WHERE workspace=? AND member_id=?').run(workspace, memberId);
  await db.prepare("DELETE FROM transactions WHERE kind='chair_mfa_pending' AND session_id=?").run(memberId);
  return epoch;
}
export async function finishAuthMutation(db, workspace, memberId, epoch) {
  const id = authMutationId(workspace, memberId);
  const row = await db.prepare("SELECT data FROM transactions WHERE id=? AND kind='auth_mutation' FOR UPDATE").get(id);
  if (!row) return;
  const state = JSON.parse(row.data);
  if (state.epoch !== epoch) return;
  await db.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify({ epoch, busyUntil: 0 }), id);
}
