import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { recoveryWords } from "./recovery-words.mjs";

// Sixteen independently sampled BIP-39 words provide 176 bits of entropy.
// This is a portal recovery key, not a wallet seed phrase or BIP-39 mnemonic.
const WORD_COUNT = 16;
const WORD_SET = new Set(recoveryWords);
const PENDING_MS = 90_000;
const NEVER_EXPIRES = 253402300799000; // Account credential state, not a timed transaction.
const INVALID_HASH = Buffer.alloc(32);
if (recoveryWords.length !== 2048 || WORD_SET.size !== 2048)
  throw Error("Recovery word list is incomplete.");

export function generateRecoveryKey() {
  return Array.from({ length: WORD_COUNT }, () => recoveryWords[randomInt(2048)]).join(" ");
}

export function normalizeRecoveryKey(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  const words = value.trim().toLowerCase().split(/\s+/);
  return words.length === WORD_COUNT && words.every((word) => WORD_SET.has(word))
    ? words.join(" ") : null;
}

function digest(salt, phrase) {
  return createHash("sha256")
    .update("ato-scholarship-recovery-v1\0")
    .update(Buffer.from(salt, "hex")).update("\0").update(phrase).digest();
}

function freshSecret() {
  const key = generateRecoveryKey();
  const salt = randomBytes(16).toString("hex");
  return { key, salt, hash: digest(salt, key).toString("hex") };
}

function equalHash(expected, actual) {
  const bytes = typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected)
    ? Buffer.from(expected, "hex") : INVALID_HASH;
  return timingSafeEqual(bytes, actual);
}

function credentialId(workspace, memberId) {
  return createHash("sha256").update(`recovery-key\0${workspace}\0${memberId}`).digest("hex");
}

async function load(db, workspace, memberId) {
  const row = await db.prepare(
    "SELECT data FROM transactions WHERE id=? AND kind='recovery_key' FOR UPDATE",
  ).get(credentialId(workspace, memberId));
  if (!row) return null;
  try {
    const state = JSON.parse(row.data);
    if (typeof state.generation !== "string" ||
        (state.hash !== null && typeof state.hash !== "string") ||
        (state.salt !== null && typeof state.salt !== "string")) throw Error();
    return state;
  } catch { throw Error("Recovery credential state is unavailable."); }
}

async function save(db, workspace, memberId, state) {
  await db.prepare(
    "INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,'recovery_key',NULL,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires=excluded.expires",
  ).run(credentialId(workspace, memberId), JSON.stringify(state), NEVER_EXPIRES);
}

// New keys are not considered delivered until the member confirms saving them.
// Legacy keys predate confirmation; preserve them until rotation or use.
const confirmed = row => !!row?.hash && (row.schema !== 2 || !!row.confirmedAt);
export async function recoveryKeyStatus(db, workspace, memberId, generation) {
  const row = await load(db, workspace, memberId);
  return { needsKey: row?.generation !== generation || !confirmed(row) };
}

// Caller must hold the workspace lock and verify the session (and password for
// replacement of a confirmed key). Only hashes are persisted, never the words.
export async function issueSemesterRecoveryKey(db, workspace, memberId, generation, { replace = false } = {}) {
  const row = await load(db, workspace, memberId);
  if (row?.pendingUntil > Date.now())
    throw Object.assign(Error("Account recovery is in progress. Try again shortly."), { status: 409 });
  if (!replace && row?.generation === generation && confirmed(row)) return null;
  const secret = freshSecret();
  await save(db, workspace, memberId, {
    schema: 2, generation, salt: secret.salt, hash: secret.hash,
    confirmedAt: null, pendingToken: null, pendingUntil: null,
    issuedAt: new Date().toISOString(),
  });
  return secret.key;
}

export async function confirmRecoveryKey(db, workspace, memberId, generation, enteredKey) {
  const row = await load(db, workspace, memberId);
  const phrase = normalizeRecoveryKey(enteredKey);
  const actual = digest(row?.salt || "00000000000000000000000000000000", phrase || "");
  if (!phrase || row?.generation !== generation || !equalHash(row?.hash, actual) || row.pendingToken)
    throw Object.assign(Error("This key was replaced. Get a new key and save it before continuing."), { status: 409 });
  if (!row.confirmedAt) {
    row.confirmedAt = new Date().toISOString();
    await save(db, workspace, memberId, row);
  }
  return { confirmed: true };
}

// Irrevocably consume the credential BEFORE contacting the password provider.
// A timeout is ambiguous: it must never make an already-used key reusable.
export async function beginRecovery(db, workspace, memberId, generation, enteredKey) {
  const row = await load(db, workspace, memberId);
  const phrase = normalizeRecoveryKey(enteredKey);
  const actual = digest(row?.salt || "00000000000000000000000000000000", phrase || "");
  if (!phrase || row?.generation !== generation || !confirmed(row) ||
      !equalHash(row.hash, actual) || row.pendingToken) return null;
  const reservation = randomBytes(32).toString("hex");
  row.hash = null;
  row.salt = null;
  row.confirmedAt = null;
  row.pendingToken = reservation;
  row.pendingUntil = Date.now() + PENDING_MS;
  row.consumedAt = new Date().toISOString();
  await save(db, workspace, memberId, row);
  await db.prepare("DELETE FROM sessions WHERE workspace=? AND member_id=?")
    .run(workspace, memberId);
  return reservation;
}

// On provider failure the member can sign in with the current password or use
// email recovery. The consumed key is NEVER restored, even after the lease ends.
export async function cancelRecovery(db, workspace, memberId, reservation) {
  const row = await load(db, workspace, memberId);
  if (row?.pendingToken !== reservation) return;
  row.pendingToken = null;
  row.pendingUntil = null;
  await save(db, workspace, memberId, row);
}

export async function finishRecovery(db, workspace, memberId, generation, reservation) {
  const row = await load(db, workspace, memberId);
  if (row?.generation !== generation || row?.pendingToken !== reservation)
    throw Error("Recovery reservation changed or expired.");
  row.pendingToken = null;
  row.pendingUntil = null;
  await save(db, workspace, memberId, row);
  await db.prepare("DELETE FROM sessions WHERE workspace=? AND member_id=?")
    .run(workspace, memberId);
  // The next verified password sign-in issues a fresh, confirmable key.
  return null;
}

export async function clearRecoveryKey(db, workspace, memberId) {
  await db.prepare("DELETE FROM transactions WHERE id=? AND kind='recovery_key'")
    .run(credentialId(workspace, memberId));
}
