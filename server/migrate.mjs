import { openDatabase } from "./database.mjs";
if (!process.env.DATABASE_URL)
  throw Error(
    "Set the server-only DATABASE_URL before running the PostgreSQL migration.",
  );
const db = await openDatabase({ migrate: true });
await db.close();
console.log("Private portal database schema is ready.");
