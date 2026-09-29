import { createHash } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";

const MAX_ROWS = 1000;
const MAX_BYTES = 256 * 1024;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const rosterError = (message) =>
  Object.assign(new Error(message), { status: 503 });

export function rosterStatus(env = process.env) {
  const id = String(env.ROSTER_SHEET_ID || "").trim();
  const range = String(env.ROSTER_SHEET_RANGE || "'Roster'!D1:E1002").trim();
  const email = String(env.ROSTER_SERVICE_ACCOUNT_EMAIL || "").trim();
  const key = String(env.ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(
    /\\n/g,
    "\n",
  );
  const required =
    env.ROSTER_REQUIRED === "true" ||
    Boolean(id || email || key || env.ROSTER_SHEET_RANGE);
  const configured =
    /^[A-Za-z0-9_-]{20,150}$/.test(id) &&
    /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email) &&
    key.includes("-----BEGIN PRIVATE KEY-----") &&
    range.length > 0 &&
    range.length <= 200;
  return {
    configured,
    required,
    maxAgeMs: 15 * 60 * 1000,
    source: digest(JSON.stringify([id, range])),
  };
}

// Only explicit portal IDs are authorization inputs. Names, phone numbers, and
// inferred email addresses never reach the membership comparison.
export function parseRosterValues(values) {
  if (
    !Array.isArray(values) ||
    values.length < 2 ||
    values.length > MAX_ROWS + 1
  )
    throw rosterError("Roster must contain a header and 1–1000 member rows.");
  const headers = values[0].map((value) => String(value).trim().toLowerCase());
  if (
    headers.length !== 2 ||
    headers[0] !== "portal member id" ||
    headers[1] !== "active"
  )
    throw rosterError(
      "Roster range must contain exactly Portal Member ID and Active columns.",
    );
  const seen = new Set();
  const ids = [];
  for (const row of values.slice(1)) {
    if (!Array.isArray(row) || row.length > 2)
      throw rosterError("Roster contains an invalid row.");
    const id = String(row[0] ?? "").trim();
    const active = String(row[1] ?? "")
      .trim()
      .toLowerCase();
    if (!id && !active) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || seen.has(id))
      throw rosterError(
        "Roster contains a missing, duplicate, or invalid Portal Member ID.",
      );
    if (!["true", "false", "active", "inactive"].includes(active))
      throw rosterError(
        "Every roster member needs an explicit TRUE or FALSE Active value.",
      );
    seen.add(id);
    if (active === "true" || active === "active") ids.push(id);
  }
  if (!seen.size)
    throw rosterError(
      "An empty roster cannot replace the current access list.",
    );
  return ids.sort();
}

async function readJSON(response) {
  if (!response.ok || !response.body)
    throw rosterError(
      "Google Sheets could not be read. Check the service account and sheet sharing.",
    );
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES)
        throw rosterError(
          "Roster response is too large. Narrow the configured range.",
        );
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchRosterSnapshot({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const status = rosterStatus(env);
  if (!status.configured)
    throw rosterError(
      "Roster sync is required but its Google Sheets settings are incomplete.",
    );
  const startedAt = now();
  const seconds = Math.floor(startedAt / 1000);
  const signal = AbortSignal.timeout(15_000);
  try {
    const key = await importPKCS8(
      env.ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
      "RS256",
    );
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(env.ROSTER_SERVICE_ACCOUNT_EMAIL.trim())
      .setAudience(TOKEN_URL)
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + 300)
      .sign(key);
    const token = await readJSON(
      await fetchImpl(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      }),
    );
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      token.access_token.length > 8192
    )
      throw rosterError("Google did not return a usable roster access token.");
    const range = String(env.ROSTER_SHEET_RANGE || "'Roster'!D1:E1002").trim();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.ROSTER_SHEET_ID.trim())}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    const data = await readJSON(
      await fetchImpl(url, {
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${token.access_token}` },
      }),
    );
    const ids = parseRosterValues(data.values);
    return {
      ids,
      fetchedAt: new Date(startedAt).toISOString(),
      revision: digest(JSON.stringify(data.values)),
      source: status.source,
    };
  } catch (error) {
    if (error.status === 503) throw error;
    throw rosterError(
      "Roster sync failed. Access stays restricted until a successful refresh.",
    );
  }
}
