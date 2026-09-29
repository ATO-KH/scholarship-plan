import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import {
  openDatabase,
  postgresSql,
  databaseConnectionOptions,
} from "../server/database.mjs";

test("SQL values remain parameters and private table names are schema-qualified", () => {
  assert.equal(
    postgresSql(
      "SELECT data FROM chapters WHERE workspace=? AND data <> 'sessions?'",
    ),
    "SELECT data FROM scholarship_private.chapters WHERE workspace=$1 AND data <> 'sessions?'",
  );
});

test("URL TLS overrides cannot disable verified remote PostgreSQL TLS", () => {
  for (const query of [
    "sslmode=disable",
    "sslmode=no-verify",
    "ssl=false",
    "uselibpqcompat=true&sslmode=require",
  ]) {
    const options = databaseConnectionOptions({
      DATABASE_URL: `postgresql://test:dummy@db.example.test/app?${query}`,
    });
    const client = new pg.Client(options);
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
    assert.equal(options.max, 1);
  }
  assert.throws(
    () =>
      databaseConnectionOptions({
        DATABASE_URL: "postgresql://test:dummy@db.example.test/app",
        DATABASE_SSL: "disable",
      }),
    /local tests/,
  );
  assert.throws(
    () =>
      databaseConnectionOptions({
        DATABASE_URL: "postgresql://test:dummy@db.example.test/app",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    /Verified database TLS/,
  );
});

test("a separate database password preserves special characters and rejects ambiguous configuration", () => {
  const url = "postgresql://postgres.project@pooler.example.test:6543/postgres";
  assert.equal(
    databaseConnectionOptions({ DATABASE_URL: url, DATABASE_PASSWORD: "a@b:c#d/e" }).password,
    "a@b:c#d/e",
  );
  assert.throws(
    () => databaseConnectionOptions({ DATABASE_URL: url }),
    /PostgreSQL password is required/,
  );
  assert.throws(
    () => databaseConnectionOptions({ DATABASE_URL: url.replace("@pooler", ":embedded@pooler"), DATABASE_PASSWORD: "separate" }),
    /either DATABASE_URL or DATABASE_PASSWORD/,
  );
});

test("hosted previews and missing hosted databases never fall back to local state", async () => {
  await assert.rejects(
    openDatabase({
      env: { VERCEL: "1", VERCEL_ENV: "preview", APP_MODE: "production" },
    }),
    /previews are disabled/,
  );
  await assert.rejects(
    openDatabase({
      env: { VERCEL: "1", VERCEL_ENV: "production", APP_MODE: "production" },
    }),
    /requires DATABASE_URL/,
  );
});

test("async SQLite rollback cannot absorb an unrelated request into its transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ato-db-"));
  const db = await openDatabase({ env: {}, directory });
  try {
    let release, entered;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const first = db.transaction(async () => {
      await db
        .prepare("INSERT INTO chapters VALUES (?,?)")
        .run("rolled-back", "{}");
      entered();
      await barrier;
      throw Error("rollback fixture");
    });
    const rejected = assert.rejects(first, /rollback fixture/);
    await started;
    const second = db
      .prepare("INSERT INTO chapters VALUES (?,?)")
      .run("survives", "{}");
    release();
    await rejected;
    await second;
    assert.equal(
      await db
        .prepare("SELECT workspace FROM chapters WHERE workspace=?")
        .get("rolled-back"),
      undefined,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT workspace FROM chapters WHERE workspace=?")
          .get("survives")
      ).workspace,
      "survives",
    );
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("awaited nested transaction work commits together and supports locked reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ato-db-"));
  const db = await openDatabase({ env: {}, directory });
  try {
    await db.transaction(async () => {
      const row = await db
        .prepare("SELECT workspace FROM chapters WHERE workspace=? FOR UPDATE")
        .get("chapter");
      assert.equal(row.workspace, "chapter");
      await db.transaction(async () => {
        await db
          .prepare("UPDATE chapters SET data=? WHERE workspace=?")
          .run('{"submissions":[1]}', "chapter");
      });
    });
    assert.equal(
      (
        await db
          .prepare("SELECT data FROM chapters WHERE workspace=?")
          .get("chapter")
      ).data,
      '{"submissions":[1]}',
    );
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
