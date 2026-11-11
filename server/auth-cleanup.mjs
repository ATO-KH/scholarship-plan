// This table also contains permanent recovery keys and mutation fences. Only
// known short-lived flow/counter kinds may be collected, even if others expire.
export async function cleanupExpiredAuth(db, now = Date.now()) {
  // Recheck expiry on the deleted row too: another instance may have renewed
  // an attempt counter while this statement was waiting for its row lock.
  await db.prepare('DELETE FROM sessions WHERE expires<=? AND id IN (SELECT id FROM sessions WHERE expires<=? LIMIT 1000)').run(now, now);
  await db.prepare("DELETE FROM transactions WHERE expires<=? AND id IN (SELECT id FROM transactions WHERE expires<=? AND kind IN ('login_attempt','reset_attempt','recovery_attempt','password_change','recovery_issue','account_link','identity','canvas','chair_mfa_pending') LIMIT 1000)").run(now, now);
}
