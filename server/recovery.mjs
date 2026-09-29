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
    if (typeof state.generation !== "string" || typeof state.salt !== "string" ||
        typeof state.hash !== "string") throw Error();
    return state;
  } catch { throw Error("Recovery credential state is unavailable."); }
}

async function save(db, workspace, memberId, state) {
  await db.prepare(
    "INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,'recovery_key',NULL,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires=excluded.expires",
  ).run(credentialId(workspace, memberId), JSON.stringify(state), NEVER_EXPIRES);
}

// Call under the workspace transaction lock after verified member sign-in.
export async function issueSemesterRecoveryKey(db, workspace, memberId, generation) {
  const row = await load(db, workspace, memberId);
  if (row?.generation === generation && row.hash) {
    if (row.pendingUntil > Date.now())
      throw Object.assign(Error("Account recovery is in progress. Try again shortly."), { status: 409 });
    return null;
  }
  const secret = freshSecret();
  await save(db, workspace, memberId, {
    generation, salt: secret.salt, hash: secret.hash, pendingToken: null,
    pendingUntil: null, issuedAt: new Date().toISOString(),
  });
  return secret.key;
}

// Call under the workspace transaction lock. A reservation prevents simultaneous use.
export async function beginRecovery(db, workspace, memberId, generation, enteredKey) {
  const row = await load(db, workspace, memberId);
  const phrase = normalizeRecoveryKey(enteredKey);
  const actual = digest(row?.salt || "00000000000000000000000000000000", phrase || "");
  if (!phrase || row?.generation !== generation || !equalHash(row?.hash, actual) ||
      (row.pendingUntil && row.pendingUntil > Date.now())) return null;
  const reservation = randomBytes(32).toString("hex");
  row.pendingToken = reservation;
  row.pendingUntil = Date.now() + PENDING_MS;
  await save(db, workspace, memberId, row);
  await db.prepare("DELETE FROM sessions WHERE workspace=? AND member_id=?")
    .run(workspace, memberId);
  return reservation;
}

// A known provider failure leaves the same key usable for a retry.
export async function cancelRecovery(db, workspace, memberId, reservation) {
  const row = await load(db, workspace, memberId);
  if (row?.pendingToken !== reservation) return;
  row.pendingToken = null;
  row.pendingUntil = null;
  await save(db, workspace, memberId, row);
}

// Call under the workspace lock after the provider confirms the password update.
export async function finishRecovery(db, workspace, memberId, generation, reservation) {
  const row = await load(db, workspace, memberId);
  if (row?.generation !== generation || row?.pendingToken !== reservation ||
      !row.pendingUntil || row.pendingUntil <= Date.now())
    throw Error("Recovery reservation changed or expired.");
  const secret = freshSecret();
  await save(db, workspace, memberId, {
    generation, salt: secret.salt, hash: secret.hash, pendingToken: null,
    pendingUntil: null, issuedAt: new Date().toISOString(),
  });
  await db.prepare("DELETE FROM sessions WHERE workspace=? AND member_id=?")
    .run(workspace, memberId);
  return secret.key;
}

export async function clearRecoveryKey(db, workspace, memberId) {
  await db.prepare("DELETE FROM transactions WHERE id=? AND kind='recovery_key'")
    .run(credentialId(workspace, memberId));
}
