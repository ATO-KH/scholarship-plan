// Fictional provider used only by --import test fixtures, never production code.
const chairId = 'aab93409-383f-4d8a-b443-3d940a277153';
let next = 0;
const factors = process.env.TEST_MFA_PREENROLLED === 'true' ? [{ id: 'factor-existing', factor_type: 'totp', status: 'verified', friendly_name: 'Scholarship Chair' }] : [];
const challenges = new Set();
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const mockChairToken = (aal = 'aal1', id = chairId) => `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, aal, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fictional-test-signature`;
export function mockChairTokenUser(value) {
  if (value === 'test-chair-account-token') return chairId;
  if (!value?.endsWith('.fictional-test-signature')) return null;
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).sub; } catch { return null; }
}
export const mockChairHasVerifiedFactor = () => factors.some(factor => factor.status === 'verified');
export function mockChairTokenAal(value) {
  if (value === 'test-chair-account-token') return 'aal1';
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).aal; } catch { return null; }
}
export function mockChairMfa(url, options = {}) {
  const headers = new Headers(options.headers), authorization = headers.get('authorization');
  const id = mockChairTokenUser(authorization?.replace(/^Bearer /, ''));
  if (url.pathname === '/auth/v1/user' && (options.method || 'GET') === 'GET' && id) return respond({ id, email: id === chairId ? 'chair@example.edu' : 'wrong@example.edu', factors });
  if (!url.pathname.startsWith('/auth/v1/factors')) return null;
  if (id !== chairId) return respond({ error: 'not authorized' }, 401);
  if (url.pathname === '/auth/v1/factors' && options.method === 'POST') {
    const input = JSON.parse(options.body);
    const factor = { id: `factor-${++next}`, factor_type: 'totp', status: 'unverified', friendly_name: input.friendly_name };
    factors.push(factor);
    return respond({ ...factor, totp: { secret: 'TESTSETUPKEYONLY', qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/></svg>' } });
  }
  const [, , , , idPart, action] = url.pathname.split('/');
  const factor = factors.find(item => item.id === idPart);
  if (!factor) return respond({ error: 'missing factor' }, 404);
  if (options.method === 'DELETE') { factors.splice(factors.indexOf(factor), 1); return respond({}); }
  if (action === 'challenge') { const challenge = `challenge-${++next}`; challenges.add(challenge); return respond({ id: challenge }); }
  if (action === 'verify') {
    const { challenge_id, code } = JSON.parse(options.body);
    if (!challenges.delete(challenge_id)) return respond({ error: 'invalid challenge' }, 422);
    if (code === '111111') return respond({ error: 'unavailable' }, 503);
    if (!['123456', '222222', '333333'].includes(code)) return respond({ error: 'invalid code' }, 422);
    factor.status = 'verified';
    return respond({ access_token: mockChairToken(code === '333333' ? 'aal1' : 'aal2', code === '222222' ? 'wrong-user' : chairId) });
  }
  return respond({ error: 'missing mock route' }, 404);
}
