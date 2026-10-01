import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotEligible } from '../server/pilot-access.mjs';
test('pilot access is limited to active allowlisted member identities before expiry', () => {
 const env = { pilotAccounts: [{ id: 'pilot-a', expiresAt: '2026-11-01T04:00:00Z' }] };
 const user = { id: 'pilot-a', email: 'a@pilot.invalid', role: 'member', active: 1 };
 const now = Date.parse('2026-10-01T00:00:00Z');
 assert.equal(pilotEligible(env,user,now),true);
 for(const change of [{id:'other'},{email:'a@example.edu'},{role:'chair'},{active:0}]) assert.equal(Boolean(pilotEligible(env,{...user,...change},now)),false);
 assert.equal(Boolean(pilotEligible({},user,now)),false);
 assert.equal(Boolean(pilotEligible(env,user,Date.parse(env.pilotAccounts[0].expiresAt))),false);
});
