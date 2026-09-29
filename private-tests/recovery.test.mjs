import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/database.mjs";
import {
  generateRecoveryKey, normalizeRecoveryKey, issueSemesterRecoveryKey,
  beginRecovery, cancelRecovery, finishRecovery, clearRecoveryKey,
} from "../server/recovery.mjs";

test("16-word key is one-time, hashed, semester-scoped, retryable on provider failure, and revokes sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ato-recovery-"));
  const db = await openDatabase({ env: {}, directory });
  const memberId = "member-test";
  try {
    await db.prepare(
      "INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES (?,?,?,?,?,?,?,1)",
    ).run("chapter", memberId, "Test Member", "member@example.test", "member", 1, 15);
    const first = await db.transaction(() =>
      issueSemesterRecoveryKey(db, "chapter", memberId, "initial"));
    assert.equal(first.split(" ").length, 16);
    assert.equal(normalizeRecoveryKey(first.toUpperCase().replaceAll(" ", "\n")), first);
    assert.equal(normalizeRecoveryKey(first + " extra"), null);
    assert.equal((await db.transaction(() =>
      issueSemesterRecoveryKey(db, "chapter", memberId, "initial"))), null);
    const row = await db.prepare("SELECT data FROM transactions WHERE kind='recovery_key'").get();
    assert.equal(row.data.includes(first), false);
    assert.match(JSON.parse(row.data).hash, /^[a-f0-9]{64}$/);
    assert.match(JSON.parse(row.data).salt, /^[a-f0-9]{32}$/);
    await db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)")
      .run("session-id", "chapter", memberId, "csrf", Date.now() + 100_000);
    assert.equal(await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "initial", generateRecoveryKey())), null);
    assert.equal((await db.prepare("SELECT id FROM sessions WHERE id=?").get("session-id")).id,
      "session-id");
    const reservation = await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "initial", first));
    assert.match(reservation, /^[a-f0-9]{64}$/);
    assert.equal(await db.prepare("SELECT id FROM sessions WHERE id=?").get("session-id"), undefined);
    assert.equal(await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "initial", first)), null);
    await db.transaction(() => cancelRecovery(db, "chapter", memberId, reservation));
    const staleSemester = await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "initial", first));
    await assert.rejects(() => db.transaction(() =>
      finishRecovery(db, "chapter", memberId, "next-semester", staleSemester)),
    /changed or expired/);
    await db.transaction(() => cancelRecovery(db, "chapter", memberId, staleSemester));
    const retry = await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "initial", first));
    assert.ok(retry);
    const rotated = await db.transaction(() =>
      finishRecovery(db, "chapter", memberId, "initial", retry));
    assert.notEqual(rotated, first);
    assert.equal(await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "initial", first)), null);
    assert.equal(await db.transaction(() =>
      issueSemesterRecoveryKey(db, "chapter", memberId, "initial")), null);
    const nextSemester = await db.transaction(() =>
      issueSemesterRecoveryKey(db, "chapter", memberId, "next-semester"));
    assert.notEqual(nextSemester, rotated);
    assert.equal(await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "next-semester", rotated)), null);
    assert.equal(await db.transaction(() =>
      beginRecovery(db, "chapter", memberId, "initial", first)), null);
    await db.transaction(() => clearRecoveryKey(db, "chapter", memberId));
    assert.equal(await db.prepare("SELECT data FROM transactions WHERE kind='recovery_key'").get(), undefined);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
