import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import {
  fetchRosterSnapshot,
  parseRosterValues,
  rosterStatus,
} from "../server/roster.mjs";

const header = ["Portal Member ID", "Active"];

test("roster membership requires explicit IDs and active values, never inferred emails", () => {
  assert.deepEqual(
    parseRosterValues([
      header,
      ["alex", true],
      ["former", false],
      ["new_member", "active"],
    ]),
    ["alex", "new_member"],
  );
  assert.deepEqual(parseRosterValues([header, ["alex", false]]), []);
  for (const rows of [
    [header],
    [header, ["", ""]],
    [header, ["alex", ""]],
    [header, ["alex", true], ["alex", false]],
    [header, ["name@my.fit.edu", true]],
    [
      ["First Name", "Last Name"],
      ["Matas", "Vaitkevicius"],
    ],
    [header, ["alex", true], ["", true]],
    [header, ["alex", "maybe"]],
    [header, ...Array.from({ length: 1001 }, (_, i) => [`member${i}`, true])],
  ])
    assert.throws(() => parseRosterValues(rows));
});

test("partial roster configuration requires sync and cannot silently disable eligibility", () => {
  assert.equal(rosterStatus({}).required, false);
  for (const env of [
    { ROSTER_REQUIRED: "true" },
    { ROSTER_SHEET_ID: "partial" },
    { ROSTER_SERVICE_ACCOUNT_EMAIL: "incomplete" },
  ]) {
    assert.equal(rosterStatus(env).required, true);
    assert.equal(rosterStatus(env).configured, false);
  }
  assert.notEqual(
    rosterStatus({ ROSTER_SHEET_ID: "first" }).source,
    rosterStatus({ ROSTER_SHEET_ID: "second" }).source,
  );
});

test("Sheets reader uses a scoped service-account JWT and returns no credentials or contacts", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const env = {
    ROSTER_SHEET_ID: "a".repeat(44),
    ROSTER_SERVICE_ACCOUNT_EMAIL: "portal@chapter.iam.gserviceaccount.com",
    ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: await exportPKCS8(privateKey),
  };
  let calls = 0;
  const now = Date.now();
  const snapshot = await fetchRosterSnapshot({
    env,
    now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (calls === 1) {
        assert.equal(url, "https://oauth2.googleapis.com/token");
        const { payload } = await jwtVerify(
          options.body.get("assertion"),
          publicKey,
          { audience: url, issuer: env.ROSTER_SERVICE_ACCOUNT_EMAIL },
        );
        assert.equal(
          payload.scope,
          "https://www.googleapis.com/auth/spreadsheets.readonly",
        );
        assert.equal(payload.sub, undefined);
        return Response.json({ access_token: "fixture-token" });
      }
      assert.equal(new URL(url).origin, "https://sheets.googleapis.com");
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      return Response.json({
        values: [header, ["alex", true], ["former", false]],
      });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(snapshot.ids, ["alex"]);
  assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
  assert.equal(snapshot.source, rosterStatus(env).source);
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /fixture-token|PRIVATE KEY|former/,
  );
  await assert.rejects(
    fetchRosterSnapshot({
      env,
      fetchImpl: async () => new Response("provider-secret", { status: 403 }),
    }),
    (error) =>
      error.status === 503 && !error.message.includes("provider-secret"),
  );
  await assert.rejects(
    fetchRosterSnapshot({
      env,
      fetchImpl: async () => new Response("a".repeat(256 * 1024 + 1)),
    }),
    /too large/,
  );
});
