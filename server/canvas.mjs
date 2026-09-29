import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Canvas OAuth and endpoint definitions: https://developerdocs.instructure.com/services/canvas
// Requires an institutional scoped developer key with Allow Include Parameters enabled.
export const CANVAS_SCOPES = Object.freeze([
  "url:GET|/api/v1/courses",
  "url:GET|/api/v1/courses/:course_id/assignments",
]);
const STATE_TTL = 10 * 60 * 1000;
const MAX_COLLECTION_PAGES = 100;
const MAX_TOTAL_PAGES = 1000;
const MAX_COLLECTION_ITEMS = 50_000;
const TOKEN_AAD = Buffer.from("ato-canvas-tokens:v1");

function failure(message, code = "CANVAS_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canvasConfig(env) {
  let url;
  try {
    url = new URL(env.CANVAS_BASE_URL);
  } catch {
    throw failure(
      "Canvas is not configured. Contact the portal administrator.",
      "CANVAS_CONFIG",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw failure(
      "Canvas must be configured with its exact HTTPS origin.",
      "CANVAS_CONFIG",
    );
  }
  if (!env.CANVAS_CLIENT_ID || !env.CANVAS_CLIENT_SECRET) {
    throw failure(
      "Canvas is not configured. Contact the portal administrator.",
      "CANVAS_CONFIG",
    );
  }
  return {
    origin: url.origin,
    clientId: env.CANVAS_CLIENT_ID,
    clientSecret: env.CANVAS_CLIENT_SECRET,
  };
}

export function canvasStatus(env = process.env) {
  try {
    return { configured: true, origin: canvasConfig(env).origin };
  } catch {
    return { configured: false, origin: null };
  }
}

function callbackUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure("Canvas callback URL is not configured.", "CANVAS_CONFIG");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw failure(
      "Canvas callback requires HTTPS (or a local development address).",
      "CANVAS_CONFIG",
    );
  }
  return url;
}

export function startCanvasFlow({
  env = process.env,
  redirectUri,
  now = Date.now,
}) {
  const config = canvasConfig(env);
  const redirect = callbackUri(redirectUri);
  const transaction = {
    state: randomBytes(32).toString("base64url"),
    createdAt: now(),
  };
  const url = new URL("/login/oauth2/auth", config.origin);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirect.href,
    state: transaction.state,
    scope: CANVAS_SCOPES.join(" "),
  }).toString();
  return { url: url.href, transaction };
}

async function providerFetch(url, options, fetchImpl) {
  let response;
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);
    signal.throwIfAborted();
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal,
    });
  } catch {
    // Never return exception text: it can contain request URLs or credential data.
    throw failure(
      "Canvas could not be reached securely. Please try again.",
      "CANVAS_NETWORK",
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw failure(
      "Canvas returned an unexpected redirect. Contact the portal administrator.",
      "CANVAS_REDIRECT",
    );
  }
  return response;
}

function providerFailure(status) {
  if (status === 401)
    return failure(
      "Canvas authorization expired or the required read permissions are unavailable. Reconnect Canvas.",
      "CANVAS_AUTH",
    );
  if (status === 403)
    return failure(
      "Canvas denied access. Confirm your enrollment and the integration permissions.",
      "CANVAS_FORBIDDEN",
    );
  if (status === 429)
    return failure(
      "Canvas is temporarily limiting requests. Please try again later.",
      "CANVAS_RATE_LIMIT",
    );
  return failure(
    "Canvas could not complete the request. Please try again later.",
    "CANVAS_PROVIDER",
  );
}

async function jsonResponse(response) {
  if (!response.ok) throw providerFailure(response.status);
  try {
    return await response.json();
  } catch {
    throw failure("Canvas returned an unreadable response.", "CANVAS_RESPONSE");
  }
}

function validSecret(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\r\n]/.test(value)
  );
}

function normalizedTokens(data, previousRefreshToken, now) {
  if (
    !data ||
    !validSecret(data.access_token) ||
    !validSecret(data.refresh_token ?? previousRefreshToken)
  ) {
    throw failure(
      "Canvas did not return usable authorization credentials. Reconnect Canvas.",
      "CANVAS_AUTH",
    );
  }
  const seconds = data.expires_in;
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 31_536_000
  ) {
    throw failure(
      "Canvas did not return a valid authorization expiry.",
      "CANVAS_AUTH",
    );
  }
  if (data.token_type && String(data.token_type).toLowerCase() !== "bearer") {
    throw failure(
      "Canvas returned an unsupported authorization type.",
      "CANVAS_AUTH",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previousRefreshToken,
    expiresAt: now() + seconds * 1000,
  };
}

async function exchangeToken(
  config,
  values,
  fetchImpl,
  now,
  previousRefreshToken,
  signal,
) {
  const response = await providerFetch(
    new URL("/login/oauth2/token", config.origin).href,
    {
      method: "POST",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...values,
      }),
    },
    fetchImpl,
  );
  return normalizedTokens(
    await jsonResponse(response),
    previousRefreshToken,
    now,
  );
}

// The caller must consume the transaction in its authenticated server-side session
// before invoking this function. Never put transaction state or tokens in browser storage.
export async function completeCanvasFlow({
  transaction,
  callbackUrl,
  env = process.env,
  redirectUri,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const config = canvasConfig(env);
  const redirect = callbackUri(redirectUri);
  let callback;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw failure(
      "Canvas authorization response is invalid. Start again.",
      "CANVAS_STATE",
    );
  }
  const state = callback.searchParams.get("state");
  const age = now() - transaction?.createdAt;
  if (
    !transaction ||
    !Number.isFinite(transaction.createdAt) ||
    age < 0 ||
    age >= STATE_TTL ||
    typeof transaction.state !== "string" ||
    typeof state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(transaction.state) ||
    Buffer.byteLength(state) !== Buffer.byteLength(transaction.state) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(transaction.state)) ||
    callback.searchParams.getAll("state").length !== 1 ||
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.username ||
    callback.password ||
    callback.hash
  ) {
    throw failure(
      "Canvas authorization expired or could not be verified. Start again.",
      "CANVAS_STATE",
    );
  }
  if (callback.searchParams.has("error"))
    throw failure(
      "Canvas connection was not authorized. You can try connecting again.",
      "CANVAS_DENIED",
    );
  const code = callback.searchParams.get("code");
  if (!validSecret(code) || callback.searchParams.getAll("code").length !== 1) {
    throw failure(
      "Canvas authorization response is invalid. Start again.",
      "CANVAS_AUTH",
    );
  }
  return exchangeToken(
    config,
    { grant_type: "authorization_code", redirect_uri: redirect.href, code },
    fetchImpl,
    now,
  );
}

function tokenKey(env) {
  const encoded = env.APP_ENCRYPTION_KEY;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw failure(
      "The portal encryption key is not configured.",
      "CANVAS_ENCRYPTION_CONFIG",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw failure(
      "The portal encryption key is invalid.",
      "CANVAS_ENCRYPTION_CONFIG",
    );
  return key;
}

function checkTokens(tokens) {
  if (
    !tokens ||
    !validSecret(tokens.accessToken) ||
    !validSecret(tokens.refreshToken) ||
    !Number.isFinite(tokens.expiresAt)
  ) {
    throw failure(
      "Stored Canvas authorization is invalid. Reconnect Canvas.",
      "CANVAS_AUTH",
    );
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}

export function sealTokens(tokens, env = process.env) {
  const key = tokenKey(env);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(TOKEN_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(checkTokens(tokens)), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openTokens(sealed, env = process.env) {
  const key = tokenKey(env);
  try {
    if (typeof sealed !== "string" || sealed.length > 50_000) throw new Error();
    const pieces = sealed.split(".");
    if (
      pieces.length !== 4 ||
      pieces[0] !== "v1" ||
      pieces.slice(1).some((p) => !/^[A-Za-z0-9_-]+$/.test(p))
    )
      throw new Error();
    const [nonce, tag, ciphertext] = pieces
      .slice(1)
      .map((p) => Buffer.from(p, "base64url"));
    if (nonce.length !== 12 || tag.length !== 16 || !ciphertext.length)
      throw new Error();
    if (
      [nonce, tag, ciphertext].some(
        (b, i) => b.toString("base64url") !== pieces[i + 1],
      )
    )
      throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(tag);
    return checkTokens(
      JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          "utf8",
        ),
      ),
    );
  } catch {
    throw failure(
      "Stored Canvas authorization could not be opened. Reconnect Canvas.",
      "CANVAS_TOKEN_STORAGE",
    );
  }
}

function checkedApiUrl(value, origin, collectionPath) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure(
      "Canvas returned an invalid pagination link.",
      "CANVAS_PAGINATION",
    );
  }
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    ![collectionPath, `${collectionPath}.json`].includes(url.pathname) ||
    url.searchParams.has("access_token")
  ) {
    throw failure(
      "Canvas returned an unsafe pagination link. No further pages were requested.",
      "CANVAS_PAGINATION",
    );
  }
  return url.href;
}

function nextPage(header) {
  if (!header) return null;
  // Split only between Link entries; a quoted parameter can contain commas.
  const links = header.split(/,(?=\s*<)/);
  let next = null;
  for (const link of links) {
    const match = link.trim().match(/^<([^<>]+)>\s*((?:;.*)?)$/);
    if (!match)
      throw failure(
        "Canvas returned an invalid pagination header.",
        "CANVAS_PAGINATION",
      );
    const rel = match[2].match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
    if (rel && (rel[1] ?? rel[2]).split(/\s+/).includes("next")) {
      if (next)
        throw failure(
          "Canvas returned ambiguous pagination links.",
          "CANVAS_PAGINATION",
        );
      next = match[1];
    }
  }
  return next;
}

function numericId(value) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && /^[1-9][0-9]{0,29}$/.test(value);
}

function normalizeAssignment(assignment, course) {
  const submission = assignment?.submission;
  const score = submission?.score;
  const points = assignment?.points_possible;
  if (
    !numericId(assignment?.id) ||
    (assignment.course_id != null &&
      String(assignment.course_id) !== String(course.id)) ||
    !submission ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    typeof points !== "number" ||
    !Number.isFinite(points) ||
    points <= 0 ||
    submission.workflow_state !== "graded" ||
    submission.excused === true ||
    submission.assignment_visible === false ||
    assignment.published === false ||
    assignment.muted === true ||
    submission.hidden === true ||
    typeof submission.posted_at !== "string" ||
    !Number.isFinite(Date.parse(submission.posted_at))
  )
    return null;
  // Keep eligibility arithmetic exact to the provider's numeric score; UI may
  // format this for display, but rounding here could push a grade over a cutoff.
  const percent = (score / points) * 100;
  if (!Number.isFinite(percent)) return null;
  return {
    id: assignment.id,
    course_id: course.id,
    name:
      typeof assignment.name === "string"
        ? assignment.name.slice(0, 1000)
        : "Assignment",
    course: String(course.course_code || course.name || "Course").slice(0, 250),
    points_possible: points,
    grading_type:
      typeof assignment.grading_type === "string"
        ? assignment.grading_type
        : "points",
    submission: {
      score,
      grade:
        typeof submission.grade === "string"
          ? submission.grade.slice(0, 100)
          : null,
      graded_at:
        typeof submission.graded_at === "string" &&
        Number.isFinite(Date.parse(submission.graded_at))
          ? submission.graded_at
          : null,
      posted_at: submission.posted_at,
      workflow_state: "graded",
      excused: false,
    },
    percent,
  };
}

// Shared deployments inject a database-coordinated refresh operation below.
// This primitive only exchanges tokens; it never persists them itself.
export async function refreshCanvasTokens({
  env = process.env,
  tokens,
  redirectUri,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  signal,
}) {
  const config = canvasConfig(env);
  const current = checkTokens(tokens);
  const redirect = redirectUri ? callbackUri(redirectUri).href : null;
  return exchangeToken(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      ...(redirect ? { redirect_uri: redirect } : {}),
    },
    fetchImpl,
    now,
    current.refreshToken,
    signal,
  );
}

export async function fetchCanvasAssignments({
  env = process.env,
  tokens,
  onTokenRefresh,
  refreshTokens,
  redirectUri,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  signal: callerSignal,
}) {
  const config = canvasConfig(env);
  const deadline = AbortSignal.timeout(90_000);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline])
    : deadline;
  let current = checkTokens(tokens);
  let refreshUsed = false;
  let totalPages = 0;
  async function refresh() {
    if (refreshUsed) throw providerFailure(401);
    refreshUsed = true;
    signal.throwIfAborted();
    const refreshed = checkTokens(
      await (refreshTokens
        ? refreshTokens(current, { signal })
        : refreshCanvasTokens({
            env,
            tokens: current,
            redirectUri,
            fetchImpl,
            now,
            signal,
          })),
    );
    signal.throwIfAborted();
    // Persist a rotated access token before subsequent requests.
    if (onTokenRefresh) await onTokenRefresh(refreshed);
    current = refreshed;
  }
  if (current.expiresAt <= now() + 30_000) await refresh();
  async function page(url) {
    let response = await providerFetch(
      url,
      {
        method: "GET",
        signal,
        headers: {
          Accept: "application/json+canvas-string-ids",
          Authorization: `Bearer ${current.accessToken}`,
        },
      },
      fetchImpl,
    );
    if (response.status === 401 && !refreshUsed) {
      await refresh();
      response = await providerFetch(
        url,
        {
          method: "GET",
          signal,
          headers: {
            Accept: "application/json+canvas-string-ids",
            Authorization: `Bearer ${current.accessToken}`,
          },
        },
        fetchImpl,
      );
    }
    const data = await jsonResponse(response);
    if (!Array.isArray(data))
      throw failure(
        "Canvas returned an unexpected response.",
        "CANVAS_RESPONSE",
      );
    return { data, next: nextPage(response.headers.get("link")) };
  }
  async function collection(path, query) {
    const first = new URL(path, config.origin);
    first.search = new URLSearchParams({
      per_page: "100",
      ...query,
    }).toString();
    let next = first.href;
    const seen = new Set();
    const items = [];
    while (next) {
      const url = checkedApiUrl(next, config.origin, path);
      if (seen.has(url))
        throw failure(
          "Canvas pagination repeated a page. The import was stopped.",
          "CANVAS_PAGINATION",
        );
      if (seen.size >= MAX_COLLECTION_PAGES || totalPages >= MAX_TOTAL_PAGES) {
        throw failure(
          "Canvas returned too many pages for one import. No partial results were imported.",
          "CANVAS_LIMIT",
        );
      }
      seen.add(url);
      totalPages += 1;
      const result = await page(url);
      if (items.length + result.data.length > MAX_COLLECTION_ITEMS)
        throw failure(
          "Canvas returned too many records for one import. No partial results were imported.",
          "CANVAS_LIMIT",
        );
      items.push(...result.data);
      next = result.next;
    }
    return items;
  }
  const courses = await collection("/api/v1/courses", {
    enrollment_type: "student",
    enrollment_state: "active",
  });
  const result = [];
  const seenCourses = new Set();
  const seenAssignments = new Set();
  for (const course of courses) {
    if (!numericId(course?.id) || seenCourses.has(String(course.id))) continue;
    if (
      Array.isArray(course.enrollments) &&
      !course.enrollments.some(
        (e) =>
          ["student", "StudentEnrollment"].includes(e.type) &&
          (!e.enrollment_state || e.enrollment_state === "active"),
      )
    )
      continue;
    seenCourses.add(String(course.id));
    const assignments = await collection(
      `/api/v1/courses/${course.id}/assignments`,
      { "include[]": "submission" },
    );
    for (const assignment of assignments) {
      const normalized = normalizeAssignment(assignment, course);
      if (!normalized) continue;
      const key = `${normalized.course_id}:${normalized.id}`;
      if (seenAssignments.has(key)) continue;
      seenAssignments.add(key);
      result.push(normalized);
    }
  }
  return result;
}
