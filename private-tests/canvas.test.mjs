import test from "node:test";
import assert from "node:assert/strict";
import {
  canvasStatus,
  startCanvasFlow,
  completeCanvasFlow,
  fetchCanvasAssignments,
  sealTokens,
  openTokens,
  CANVAS_SCOPES,
} from "../server/canvas.mjs";

const origin = "https://school.instructure.com";
const env = {
  CANVAS_BASE_URL: origin,
  CANVAS_CLIENT_ID: "test-client",
  CANVAS_CLIENT_SECRET: "test-client-secret",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const now = () => 1_800_000_000_000;
const tokens = {
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  expiresAt: now() + 3_600_000,
};
const redirectUri = "https://portal.example.edu/auth/canvas/callback";
const json = (data, options = {}) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    status: options.status ?? 200,
  });
const course = {
  id: 10,
  course_code: "MTH 1001",
  enrollments: [{ type: "student", enrollment_state: "active" }],
};
const assignment = (id, changes = {}, submissionChanges = {}) => ({
  id,
  course_id: 10,
  name: `Assignment ${id}`,
  points_possible: 20,
  grading_type: "points",
  published: true,
  ...changes,
  submission: {
    score: 18,
    grade: "18",
    graded_at: "2026-09-20T10:00:00Z",
    posted_at: "2026-09-20T11:00:00Z",
    workflow_state: "graded",
    excused: false,
    ...submissionChanges,
  },
});

test("Canvas configuration accepts only a fixed HTTPS origin and advertises no secrets", () => {
  assert.deepEqual(canvasStatus(env), { configured: true, origin });
  for (const bad of [
    "http://school.instructure.com",
    `${origin}/api/v1`,
    `${origin}?x=1`,
    "https://name:secret@school.instructure.com",
  ]) {
    assert.deepEqual(canvasStatus({ ...env, CANVAS_BASE_URL: bad }), {
      configured: false,
      origin: null,
    });
  }
  assert.equal(
    canvasStatus({ ...env, CANVAS_CLIENT_SECRET: "" }).configured,
    false,
  );
});

test("OAuth requests only two read scopes, binds state, and exchanges credentials server-side", async () => {
  const { url, transaction } = startCanvasFlow({ env, redirectUri, now });
  const request = new URL(url);
  assert.equal(request.origin, origin);
  assert.equal(request.pathname, "/login/oauth2/auth");
  assert.deepEqual(request.searchParams.get("scope").split(" "), CANVAS_SCOPES);
  assert.equal(request.searchParams.get("state"), transaction.state);
  assert.equal(request.searchParams.has("client_secret"), false);
  assert.equal(transaction.createdAt, now());
  let calls = 0;
  const actual = await completeCanvasFlow({
    env,
    redirectUri,
    transaction,
    now,
    callbackUrl: `${redirectUri}?state=${transaction.state}&code=one-use-code`,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, `${origin}/login/oauth2/token`);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.body.get("client_secret"), env.CANVAS_CLIENT_SECRET);
      assert.equal(options.body.get("grant_type"), "authorization_code");
      assert.equal(options.body.get("redirect_uri"), redirectUri);
      return json({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: 3600,
        token_type: "Bearer",
      });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(actual, tokens);
});

test("OAuth rejects expired, mismatched, duplicated, future, and cross-callback state without making a request", async () => {
  const { transaction } = startCanvasFlow({ env, redirectUri, now });
  const valid = `${redirectUri}?state=${transaction.state}&code=x`;
  const cases = [
    {
      transaction: { ...transaction, createdAt: now() - 600_000 },
      callbackUrl: valid,
    },
    {
      transaction: { ...transaction, createdAt: now() + 1 },
      callbackUrl: valid,
    },
    { transaction, callbackUrl: `${redirectUri}?state=wrong&code=x` },
    { transaction, callbackUrl: `${valid}&state=${transaction.state}` },
    {
      transaction,
      callbackUrl: valid.replace("portal.example.edu", "attacker.example.edu"),
    },
    { transaction: null, callbackUrl: valid },
  ];
  for (const scenario of cases) {
    await assert.rejects(
      completeCanvasFlow({
        env,
        redirectUri,
        now,
        ...scenario,
        fetchImpl: async () =>
          assert.fail("Invalid state must not make a request"),
      }),
      { code: "CANVAS_STATE" },
    );
  }
});

test("OAuth provider failure text is never included in application errors", async () => {
  const { transaction } = startCanvasFlow({ env, redirectUri, now });
  await assert.rejects(
    completeCanvasFlow({
      env,
      redirectUri,
      transaction,
      now,
      callbackUrl: `${redirectUri}?state=${transaction.state}&error=access_denied&error_description=secret`,
    }),
    (error) =>
      error.code === "CANVAS_DENIED" && !error.message.includes("secret"),
  );
  await assert.rejects(
    completeCanvasFlow({
      env,
      redirectUri,
      transaction,
      now,
      callbackUrl: `${redirectUri}?state=${transaction.state}&code=secret`,
      fetchImpl: async () =>
        json({ error: "bad token secret" }, { status: 400 }),
    }),
    (error) =>
      error.code === "CANVAS_PROVIDER" && !error.message.includes("secret"),
  );
});

test("Course and assignment pagination retain real zero while excluding null, excused and unposted grades", async () => {
  const requests = [];
  const actual = await fetchCanvasAssignments({
    env,
    tokens,
    now,
    fetchImpl: async (value, options) => {
      const url = new URL(value);
      requests.push(url);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(
        options.headers.Authorization,
        `Bearer ${tokens.accessToken}`,
      );
      if (url.pathname === "/api/v1/courses" && !url.searchParams.has("page")) {
        assert.equal(url.searchParams.get("enrollment_type"), "student");
        assert.equal(url.searchParams.get("enrollment_state"), "active");
        return json([course], {
          headers: {
            Link: `<${origin}/api/v1/courses?page=2>; rel="next", <${origin}/api/v1/courses?page=1>; rel="current"`,
          },
        });
      }
      if (url.pathname === "/api/v1/courses")
        return json([
          {
            id: 20,
            enrollments: [{ type: "teacher", enrollment_state: "active" }],
          },
        ]);
      if (!url.searchParams.has("page")) {
        assert.equal(url.searchParams.get("include[]"), "submission");
        return json(
          [
            assignment(1, {}, { score: 0, grade: "0" }),
            assignment(2, {}, { score: null }),
            assignment(3, {}, { excused: true }),
            assignment(4, {}, { posted_at: null }),
            assignment(5, { points_possible: 0 }),
            assignment(6, {}, { workflow_state: "submitted" }),
            assignment(7, { muted: true }),
            assignment(8, {}, { hidden: true }),
            assignment(9, { points_possible: "20" }),
            assignment(10, { course_id: 999 }),
            assignment(11, {}, { score: "0" }),
          ],
          {
            headers: {
              link: `<${origin}/api/v1/courses/10/assignments?page=2>; rel="next"`,
            },
          },
        );
      }
      return json([assignment(12), assignment(1)]);
    },
  });
  assert.equal(requests.length, 4);
  assert.deepEqual(
    actual.map((a) => [a.id, a.percent, a.submission.score]),
    [
      [1, 0, 0],
      [12, 90, 18],
    ],
  );
  assert.equal(actual[0].course, "MTH 1001");
  assert.equal(actual[0].submission.excused, false);
});

test("Pagination never sends bearer credentials to another origin, protocol or endpoint", async () => {
  for (const target of [
    "https://attacker.example/courses",
    "http://school.instructure.com/api/v1/courses?page=2",
    `${origin}/api/v1/users`,
    `https://name:secret@school.instructure.com/api/v1/courses`,
    `${origin}/api/v1/courses?access_token=secret`,
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchCanvasAssignments({
        env,
        tokens,
        now,
        fetchImpl: async () => {
          calls += 1;
          return json([course], {
            headers: { link: `<${target}>; rel="next"` },
          });
        },
      }),
      { code: "CANVAS_PAGINATION" },
    );
    assert.equal(calls, 1);
  }
});

test("Percentage normalization does not round a grade across an eligibility cutoff", async () => {
  const actual = await fetchCanvasAssignments({
    env,
    tokens,
    now,
    fetchImpl: async (url) =>
      new URL(url).pathname === "/api/v1/courses"
        ? json([course])
        : json([assignment(90, { points_possible: 100 }, { score: 89.999 })]),
  });
  assert.equal(actual.length, 1);
  assert.equal(actual[0].percent, 89.999);
  assert.ok(actual[0].percent < 90);
});

test("Canvas redirects and malformed pagination are rejected without leaking provider text", async () => {
  await assert.rejects(
    fetchCanvasAssignments({
      env,
      tokens,
      now,
      fetchImpl: async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://attacker.example" },
        }),
    }),
    { code: "CANVAS_REDIRECT" },
  );
  await assert.rejects(
    fetchCanvasAssignments({
      env,
      tokens,
      now,
      fetchImpl: async () => {
        throw new Error("leaked secret-token URL");
      },
    }),
    (error) =>
      error.code === "CANVAS_NETWORK" &&
      !error.message.includes("secret-token"),
  );
  await assert.rejects(
    fetchCanvasAssignments({
      env,
      tokens,
      now,
      fetchImpl: async () =>
        json([], { headers: { link: "unparseable next page" } }),
    }),
    { code: "CANVAS_PAGINATION" },
  );
});

test("Repeated pagination and bounds throw instead of returning partial results", async () => {
  let calls = 0;
  await assert.rejects(
    fetchCanvasAssignments({
      env,
      tokens,
      now,
      fetchImpl: async () => {
        calls += 1;
        return json([], {
          headers: { link: `<${origin}/api/v1/courses?page=2>; rel="next"` },
        });
      },
    }),
    { code: "CANVAS_PAGINATION" },
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    fetchCanvasAssignments({
      env,
      tokens,
      now,
      fetchImpl: async () => {
        calls += 1;
        return json([], {
          headers: {
            link: `<${origin}/api/v1/courses?page=${calls + 1}>; rel="next"`,
          },
        });
      },
    }),
    { code: "CANVAS_LIMIT" },
  );
  assert.equal(calls, 100);
});

test("Expired tokens refresh before loading courses and keep the Canvas refresh token", async () => {
  const events = [];
  const expired = { ...tokens, expiresAt: now() - 1 };
  const result = await fetchCanvasAssignments({
    env,
    tokens: expired,
    now,
    redirectUri,
    onTokenRefresh: async (actual) => {
      events.push("persist");
      assert.deepEqual(actual, { ...tokens, accessToken: "new-access" });
    },
    fetchImpl: async (url, options) => {
      if (url.endsWith("/login/oauth2/token")) {
        events.push("refresh");
        assert.equal(options.body.get("grant_type"), "refresh_token");
        assert.equal(options.body.get("refresh_token"), tokens.refreshToken);
        assert.equal(options.body.get("redirect_uri"), redirectUri);
        return json({ access_token: "new-access", expires_in: 3600 });
      }
      events.push("courses");
      assert.equal(options.headers.Authorization, "Bearer new-access");
      return json([]);
    },
  });
  assert.deepEqual(events, ["refresh", "persist", "courses"]);
  assert.deepEqual(result, []);
  assert.equal(expired.accessToken, tokens.accessToken);
});

test("A Canvas 401 triggers exactly one refresh and one retry", async () => {
  let refreshes = 0;
  let apiCalls = 0;
  await assert.rejects(
    fetchCanvasAssignments({
      env,
      tokens,
      now,
      fetchImpl: async (url) => {
        if (url.endsWith("/login/oauth2/token")) {
          refreshes += 1;
          return json({ access_token: "refreshed", expires_in: 3600 });
        }
        apiCalls += 1;
        return json({ error: "secret details" }, { status: 401 });
      },
    }),
    { code: "CANVAS_AUTH" },
  );
  assert.equal(refreshes, 1);
  assert.equal(apiCalls, 2);
});

test("Token encryption round-trips, randomizes ciphertext and rejects tampering or the wrong key", () => {
  const sealed = sealTokens(tokens, env);
  assert.deepEqual(openTokens(sealed, env), tokens);
  assert.notEqual(sealTokens(tokens, env), sealed);
  assert.equal(sealed.includes(tokens.accessToken), false);
  const pieces = sealed.split(".");
  for (const index of [1, 2, 3]) {
    const corrupt = [...pieces];
    corrupt[index] =
      `${corrupt[index][0] === "A" ? "B" : "A"}${corrupt[index].slice(1)}`;
    assert.throws(() => openTokens(corrupt.join("."), env), {
      code: "CANVAS_TOKEN_STORAGE",
    });
  }
  assert.throws(
    () =>
      openTokens(sealed, {
        ...env,
        APP_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
      }),
    { code: "CANVAS_TOKEN_STORAGE" },
  );
  assert.throws(() => sealTokens(tokens, { APP_ENCRYPTION_KEY: "not-a-key" }), {
    code: "CANVAS_ENCRYPTION_CONFIG",
  });
});
