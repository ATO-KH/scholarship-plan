import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const MAX_TRANSACTION_AGE = 10 * 60 * 1000;
const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const keySets = new Map();

export class IdentityError extends Error {
  constructor(message, status = 400, code = "identity_invalid") {
    super(message);
    this.name = "IdentityError";
    this.status = status;
    this.code = code;
  }
}

function reject(message, status = 400, code) {
  throw new IdentityError(message, status, code);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function configuration(provider, env) {
  if (provider === "microsoft") {
    const tenant = text(env.MICROSOFT_TENANT_ID).toLowerCase();
    const clientId = text(env.MICROSOFT_CLIENT_ID);
    const clientSecret = text(env.MICROSOFT_CLIENT_SECRET);
    if (
      !UUID.test(tenant) ||
      tenant === PERSONAL_TENANT ||
      !UUID.test(clientId) ||
      !clientSecret
    )
      reject(
        "Microsoft sign-in is not configured for an approved organization.",
        503,
        "identity_unconfigured",
      );
    const authority = `https://login.microsoftonline.com/${tenant}`;
    return {
      tenant,
      clientId,
      clientSecret,
      authorize: `${authority}/oauth2/v2.0/authorize`,
      token: `${authority}/oauth2/v2.0/token`,
      issuer: `${authority}/v2.0`,
      jwks: `${authority}/discovery/v2.0/keys`,
    };
  }
  if (provider === "google") {
    const tenant = text(env.GOOGLE_HOSTED_DOMAIN).toLowerCase();
    const clientId = text(env.GOOGLE_CLIENT_ID);
    const clientSecret = text(env.GOOGLE_CLIENT_SECRET);
    if (!DOMAIN.test(tenant) || !clientId || !clientSecret)
      reject(
        "Google sign-in is not configured for an approved organization.",
        503,
        "identity_unconfigured",
      );
    return {
      tenant,
      clientId,
      clientSecret,
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      jwks: "https://www.googleapis.com/oauth2/v3/certs",
    };
  }
  reject("Unknown identity provider.");
}

export function identityProviders(env = process.env) {
  return [{ id: "microsoft", name: "Microsoft" }].map((provider) => {
    try {
      configuration(provider.id, env);
      return { ...provider, configured: true };
    } catch {
      return { ...provider, configured: false };
    }
  });
}

function checkedRedirect(redirectUri) {
  let result;
  try {
    result = new URL(redirectUri);
  } catch {
    reject("Invalid sign-in callback configuration.", 503);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(result.hostname);
  if (
    result.username ||
    result.password ||
    result.search ||
    result.hash ||
    (result.protocol !== "https:" && !(local && result.protocol === "http:"))
  )
    reject("Sign-in requires a secure callback URL.", 503);
  return result;
}

export function startIdentityFlow(
  provider,
  { env = process.env, redirectUri } = {},
) {
  const config = configuration(provider, env);
  const callback = checkedRedirect(redirectUri);
  const transaction = {
    provider,
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    createdAt: Date.now(),
  };
  const url = new URL(config.authorize);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: callback.href,
    scope: "openid profile email",
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: createHash("sha256")
      .update(transaction.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  if (provider === "google") url.searchParams.set("hd", config.tenant);
  // The claim must also be enabled as an optional ID-token claim in Entra.
  // Requiring member status blocks personal accounts invited into the approved tenant.
  if (provider === "microsoft")
    url.searchParams.set(
      "claims",
      JSON.stringify({ id_token: { acct: { essential: true } } }),
    );
  return { url: url.href, transaction };
}

function constantEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkedTransaction(transaction) {
  const elapsed = Date.now() - transaction?.createdAt;
  if (
    !transaction ||
    !Number.isFinite(transaction.createdAt) ||
    elapsed < 0 ||
    elapsed >= MAX_TRANSACTION_AGE ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(transaction.state || "") ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(transaction.nonce || "") ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(transaction.verifier || "")
  )
    reject("Sign-in expired or is invalid. Please start again.");
}

function remoteKeySet(url) {
  if (!keySets.has(url))
    keySets.set(
      url,
      createRemoteJWKSet(new URL(url), {
        timeoutDuration: 10_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60 * 1000,
      }),
    );
  return keySets.get(url);
}

/** Verify a signed ID token; keySet is a server-side dependency seam for signed-fixture tests. */
export async function verifyIdentityToken({
  idToken,
  provider,
  transaction,
  env = process.env,
  keySet,
}) {
  checkedTransaction(transaction);
  if (transaction.provider !== provider)
    reject("Identity provider does not match this sign-in.");
  const config = configuration(provider, env);
  let claims;
  try {
    if (typeof idToken !== "string" || idToken.length > 32_768)
      reject("Invalid identity token.");
    ({ payload: claims } = await jwtVerify(
      idToken,
      keySet ?? remoteKeySet(config.jwks),
      {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "aud", "exp", "iat", "sub", "nonce"],
        clockTolerance: 5,
        maxTokenAge: "10 minutes",
      },
    ));
  } catch {
    // Never surface token contents, provider bodies, secrets, or internal key errors.
    reject("Identity token could not be verified.", 403);
  }
  if (!constantEqual(claims.nonce, transaction.nonce))
    reject("Identity token nonce does not match.", 403);
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255)
    reject("Identity token has no valid subject.", 403);
  // OIDC requires azp validation when the token has more than one audience.
  if (
    (Array.isArray(claims.aud) &&
      claims.aud.length > 1 &&
      claims.azp !== config.clientId) ||
    (claims.azp !== undefined && claims.azp !== config.clientId)
  )
    reject("Identity token authorized party does not match.", 403);
  const email = text(claims.email).toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    reject("The identity provider did not supply a valid email address.", 403);
  let subject;
  if (provider === "google") {
    if (claims.hd !== config.tenant)
      reject("Use an account from the approved Google organization.", 403);
    if (claims.email_verified !== true)
      reject("The Google email address is not verified.", 403);
    subject = claims.sub;
  } else {
    if (claims.tid !== config.tenant)
      reject("Use an account from the approved Microsoft organization.", 403);
    const idp = text(claims.idp).toLowerCase();
    if (
      claims.acct !== 0 ||
      idp === "live.com" ||
      idp.includes(PERSONAL_TENANT)
    )
      reject(
        "Microsoft sign-in requires an organization member account and the acct claim.",
        403,
      );
    if (claims.email_verified !== undefined && claims.email_verified !== true)
      reject("The Microsoft email address is not verified.", 403);
    if (
      claims.oid !== undefined &&
      (typeof claims.oid !== "string" || !UUID.test(claims.oid))
    )
      reject("The Microsoft account identifier is invalid.", 403);
    subject = `${config.tenant}:${claims.oid ? `oid:${claims.oid.toLowerCase()}` : `sub:${claims.sub}`}`;
    // Microsoft email is mutable display metadata, not ownership or membership proof.
    // Authorize persisted membership using (provider, subject), never this email.
  }
  return {
    provider,
    subject,
    email,
    name: text(claims.name).slice(0, 200) || email,
    tenant: config.tenant,
  };
}

/** Caller must atomically consume the browser-bound server transaction before invoking this. */
export async function completeIdentityFlow({
  transaction,
  callbackUrl,
  env = process.env,
  redirectUri,
  fetchImpl = globalThis.fetch,
  keySet,
} = {}) {
  checkedTransaction(transaction);
  const config = configuration(transaction.provider, env);
  const redirect = checkedRedirect(redirectUri);
  let callback;
  try {
    callback = new URL(callbackUrl);
  } catch {
    reject("Invalid sign-in callback.");
  }
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    reject("Sign-in callback does not match the registered address.");
  for (const parameter of ["state", "code", "error", "iss"]) {
    if (callback.searchParams.getAll(parameter).length > 1)
      reject("Duplicate sign-in callback parameter.");
  }
  if (!constantEqual(callback.searchParams.get("state"), transaction.state))
    reject("Sign-in state does not match.");
  const responseIssuer = callback.searchParams.get("iss");
  const issuers = Array.isArray(config.issuer)
    ? config.issuer
    : [config.issuer];
  if (responseIssuer && !issuers.includes(responseIssuer))
    reject("Sign-in response issuer does not match.", 403);
  if (callback.searchParams.has("error"))
    reject("The identity provider did not complete sign-in.", 403);
  const code = callback.searchParams.get("code");
  if (!code || code.length > 8192)
    reject("Sign-in callback has no valid authorization code.");
  let tokens;
  try {
    const response = await fetchImpl(config.token, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect.href,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: transaction.verifier,
      }),
    });
    if (!response.ok) reject("Sign-in code could not be exchanged.", 403);
    tokens = await response.json();
    if (!tokens || typeof tokens.id_token !== "string")
      reject("No identity token was returned.", 403);
  } catch {
    reject(
      "The identity provider could not complete sign-in. Please try again.",
      403,
    );
  }
  // Access/refresh tokens are intentionally neither persisted nor returned to a browser.
  return verifyIdentityToken({
    idToken: tokens.id_token,
    provider: transaction.provider,
    transaction,
    env,
    keySet,
  });
}
