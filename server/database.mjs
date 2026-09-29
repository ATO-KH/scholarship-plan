import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const TABLES = new Set([
  "chapters",
  "members",
  "identities",
  "sessions",
  "transactions",
  "uploads",
  "integrations",
  "canvas_generations",
  "canvas_leases",
  "audit",
  "schema_migrations",
]);
const schema = "scholarship_private";

// Only application-authored SQL reaches this translator. Values always remain parameters.
export function postgresSql(sql) {
  let result = "",
    index = 0,
    parameter = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      const quote = char;
      result += char;
      index++;
      while (index < sql.length) {
        const next = sql[index++];
        result += next;
        if (next === quote) {
          if (sql[index] === quote) {
            result += sql[index++];
            continue;
          }
          break;
        }
      }
    } else if (char === "?") {
      result += `$${++parameter}`;
      index++;
    } else if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index++;
      const word = sql.slice(start, index);
      result +=
        TABLES.has(word) && sql[start - 1] !== "." ? `${schema}.${word}` : word;
    } else {
      result += char;
      index++;
    }
  }
  return result;
}

export function databaseConnectionOptions(env) {
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw Error("DATABASE_URL must use PostgreSQL.");
  const embeddedPassword = url.password
    ? decodeURIComponent(url.password)
    : undefined;
  const separatePassword = env.DATABASE_PASSWORD || undefined;
  if (embeddedPassword && separatePassword)
    throw Error("Set the database password in either DATABASE_URL or DATABASE_PASSWORD, not both.");
  const password = embeddedPassword || separatePassword;
  if (!password)
    throw Error("A PostgreSQL password is required in DATABASE_URL or DATABASE_PASSWORD.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const localOnly = env.DATABASE_SSL === "disable";
  if (localOnly && (!loopback || env.VERCEL || env.VERCEL_ENV))
    throw Error(
      "Unencrypted database connections are restricted to local tests.",
    );
  if (
    !localOnly &&
    (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  )
    throw Error("Verified database TLS is required.");
  // Pass parsed fields, not connectionString: pg otherwise lets URL sslmode
  // override an explicitly supplied verified SSL configuration.
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password,
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: localOnly
      ? false
      : {
          rejectUnauthorized: true,
          ...(env.DATABASE_CA_CERT
            ? { ca: env.DATABASE_CA_CERT.replaceAll("\\n", "\n") }
            : {}),
        },
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    maxLifetimeSeconds: 300,
    allowExitOnIdle: true,
    application_name: "scholarship-private",
    statement_timeout: 15_000,
  };
}

export async function openDatabase({
  env = process.env,
  directory,
  migrate = false,
} = {}) {
  const context = new AsyncLocalStorage();
  const hosted = Boolean(env.VERCEL || env.VERCEL_ENV);
  if (
    hosted &&
    (env.VERCEL_ENV !== "production" || env.APP_MODE !== "production")
  )
    throw Error(
      "Hosted previews are disabled. Use isolated local demo mode; only an explicit production deployment can access hosted state.",
    );
  if (hosted && !env.DATABASE_URL)
    throw Error(
      "Hosted production requires DATABASE_URL; local storage fallback is disabled.",
    );
  const postgres = Boolean(env.DATABASE_URL);
  let pool,
    sqlite,
    queue = Promise.resolve();
  function exclusive(fn) {
    const task = queue.then(fn, fn);
    queue = task.catch(() => {});
    return task;
  }
  if (postgres) {
    pool = new pg.Pool(databaseConnectionOptions(env));
    pool.on("error", () => {}); // Do not expose credentials or connection URLs in server logs.
    try {
      if (migrate) {
        const migration = await readFile(
          new URL("./migrations/001_postgres.sql", import.meta.url),
          "utf8",
        );
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(migration);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      const ready = await pool.query(
        `SELECT version FROM ${schema}.schema_migrations WHERE version=1`,
      );
      if (ready.rowCount !== 1) throw Error("Schema unavailable.");
    } catch {
      await pool.end();
      throw Error(
        "Database is unavailable or its schema is not ready. Run the explicit migration and check server-side database configuration.",
      );
    }
  } else {
    if (!directory) throw Error("A local data directory is required.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const filename = resolve(directory, "chapter.sqlite");
    sqlite = new DatabaseSync(filename);
    await chmod(filename, 0o600);
    sqlite.exec(
      await readFile(
        new URL("./migrations/001_sqlite.sql", import.meta.url),
        "utf8",
      ),
    );
    const columns = new Set(
      sqlite
        .prepare("PRAGMA table_info(uploads)")
        .all()
        .map((row) => row.name),
    );
    for (const [name, definition] of Object.entries({
      status: "TEXT NOT NULL DEFAULT 'ready'",
      backend: "TEXT NOT NULL DEFAULT 'local'",
      final_path: "TEXT",
    })) {
      if (!columns.has(name))
        sqlite.exec(`ALTER TABLE uploads ADD COLUMN ${name} ${definition}`);
    }
  }
  async function query(sql, values = [], result = "all") {
    const transaction = context.getStore();
    if (postgres) {
      const answer = await (transaction?.client || pool).query(
        postgresSql(sql),
        values,
      );
      for (const row of answer.rows)
        for (const name of ["size", "expires"]) {
          if (typeof row[name] === "string") {
            const number = Number(row[name]);
            if (!Number.isSafeInteger(number))
              throw Error(
                "Stored numeric value is outside the supported range.",
              );
            row[name] = number;
          }
        }
      return result === "run"
        ? { changes: answer.rowCount }
        : result === "get"
          ? answer.rows[0]
          : answer.rows;
    }
    const execute = () => {
      const prepared = sqlite.prepare(sql.replace(/\s+FOR UPDATE\b/g, ""));
      return prepared[result](...values);
    };
    return transaction ? execute() : exclusive(execute);
  }
  const database = {
    kind: postgres ? "postgres" : "sqlite",
    prepare: (sql) => ({
      get: (...values) => query(sql, values, "get"),
      all: (...values) => query(sql, values, "all"),
      run: (...values) => query(sql, values, "run"),
    }),
    async transaction(fn) {
      if (context.getStore()) return fn();
      if (postgres) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const answer = await context.run({ client }, fn);
          await client.query("COMMIT");
          return answer;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      return exclusive(async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const answer = await context.run({ sqlite: true }, fn);
          sqlite.exec("COMMIT");
          return answer;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      });
    },
    async close() {
      if (pool) await pool.end();
      else await exclusive(() => sqlite.close());
    },
  };
  await database
    .prepare(
      "INSERT INTO chapters(workspace,data) VALUES (?,?) ON CONFLICT(workspace) DO NOTHING",
    )
    .run("chapter", JSON.stringify({ submissions: [] }));
  return database;
}
