import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
if (Number(process.versions.node.split(".")[0]) < 24)
  throw Error("Node.js 24 or newer is required.");
for (const directory of ["server", "scripts", "web"]) {
  for (const entry of await readdir(resolve(root, directory))) {
    if (!/\.(mjs|js)$/.test(entry)) continue;
    const result = spawnSync(
      process.execPath,
      ["--check", resolve(root, directory, entry)],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
JSON.parse(await readFile(resolve(root, "vercel.json"), "utf8"));
await Promise.all(
  [
    "web/index.html",
    "web/style.css",
    "server.mjs",
    "server/migrations/001_postgres.sql",
  ].map((path) => readFile(resolve(root, path))),
);
console.log(
  "Source syntax and required deployment files checked. Live credentials and connectivity are checked separately.",
);
