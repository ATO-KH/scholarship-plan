import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  completeIdentityFlow,
  identityProviders,
  startIdentityFlow,
  verifyIdentityToken,
} from "../server/identity.mjs";

const tenant = "12345678-1234-1234-1234-123456789abc";
const microsoftClient = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const env = {
  MICROSOFT_TENANT_ID: tenant,
  MICROSOFT_CLIENT_ID: microsoftClient,
  MICROSOFT_CLIENT_SECRET: "test-microsoft-secret",
  GOOGLE_HOSTED_DOMAIN: "school.example.edu",
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
};
const redirectUri = "https://portal.example.edu/auth/callback/google";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "fixture-key",
  use: "sig",
  alg: "RS256",
};
const keySet = createLocalJWKSet({ keys: [jwk] });

function fixture(provider = "google") {
  return startIdentityFlow(provider, { env, redirectUri });
}

async function signed(transaction, overrides = {}, signingKey = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const microsoft = transaction.provider === "microsoft";
  const claims = {
    iss: microsoft
      ? `https://login.microsoftonline.com/${tenant}/v2.0`
      : "https://accounts.google.com",
    aud: microsoft ? microsoftClient : env.GOOGLE_CLIENT_ID,
    sub: "stable-test-subject",
    iat: now,
    exp: now + 300,
    nonce: transaction.nonce,
    email: "student@school.example.edu",
    name: "Test Student",
    ...(microsoft
      ? { tid: tenant, oid: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", acct: 0 }
      : {
          hd: env.GOOGLE_HOSTED_DOMAIN,
          email_verified: true,
        }),
    ...overrides,
  };
  // Undefined deliberately omits mandatory claims when constructing negative cases.
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .sign(signingKey);
}

async function verified(transaction, overrides = {}, signingKey = privateKey) {
  return verifyIdentityToken({
    idToken: await signed(transaction, overrides, signingKey),
    provider: transaction.provider,
    transaction,
    env,
    keySet,
  });
}

test("provider availability fails closed without exact organization configuration", () => {
  assert.deepEqual(
    identityProviders({}).map((p) => p.configured),
    [false],
  );
  assert.deepEqual(
    identityProviders(env).map((p) => p.configured),
    [true],
  );
  assert.deepEqual(identityProviders(env).map((p) => p.id), ["microsoft"]);
  for (const badTenant of [
    "common",
    "organizations",
    "consumers",
    "9188040d-6c67-4c5b-b112-36a304b66dad",
    "school.example.edu",
  ]) {
    assert.equal(
      identityProviders({ ...env, MICROSOFT_TENANT_ID: badTenant })[0]
        .configured,
      false,
    );
  }
  for (const domain of [
    "",
    "*",
    "https://school.example.edu",
    "school.example.edu/",
  ]) {
    assert.throws(
      () =>
        startIdentityFlow("google", {
          env: { ...env, GOOGLE_HOSTED_DOMAIN: domain },
          redirectUri,
        }),
      /Google sign-in is not configured/,
    );
  }
  assert.throws(
    () => startIdentityFlow("other", { env, redirectUri }),
    /Unknown identity provider/,
  );
});

test("authorization uses unpredictable state/nonce, code flow, PKCE and only identity scopes", () => {
  const first = fixture();
  const second = fixture();
  const url = new URL(first.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), "openid profile email");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(first.transaction.verifier).digest("base64url"),
  );
  assert.equal(url.searchParams.get("hd"), env.GOOGLE_HOSTED_DOMAIN);
  assert.equal(url.searchParams.get("state"), first.transaction.state);
  assert.equal(url.searchParams.get("nonce"), first.transaction.nonce);
  assert.notEqual(first.transaction.state, second.transaction.state);
  assert.notEqual(first.transaction.nonce, second.transaction.nonce);
  assert.ok(!first.url.includes(env.GOOGLE_CLIENT_SECRET));
  assert.ok(!first.url.includes(first.transaction.verifier));
  const ms = new URL(fixture("microsoft").url);
  assert.equal(ms.pathname, `/${tenant}/oauth2/v2.0/authorize`);
  assert.equal(
    JSON.parse(ms.searchParams.get("claims")).id_token.acct.essential,
    true,
  );
});

test("only HTTPS or loopback HTTP callback URLs are accepted", () => {
  for (const uri of [
    "http://portal.example.edu/auth",
    "https://user:pass@portal.example.edu/auth",
    "https://portal.example.edu/auth?x=1",
    "https://portal.example.edu/auth#token",
  ]) {
    assert.throws(() => startIdentityFlow("google", { env, redirectUri: uri }));
  }
  assert.ok(
    startIdentityFlow("google", {
      env,
      redirectUri: "http://127.0.0.1:8080/auth/callback/google",
    }).url,
  );
});

test("valid signed Google identity uses stable sub and verifies hosted domain", async () => {
  const { transaction } = fixture();
  assert.deepEqual(await verified(transaction), {
    provider: "google",
    subject: "stable-test-subject",
    email: "student@school.example.edu",
    name: "Test Student",
    tenant: env.GOOGLE_HOSTED_DOMAIN,
  });
  assert.equal(
    (await verified(transaction, { iss: "accounts.google.com" })).subject,
    "stable-test-subject",
  );
});

test("Google rejects personal, wrong-domain and unverified accounts even with matching email suffix", async () => {
  const { transaction } = fixture();
  for (const overrides of [
    { hd: undefined },
    { hd: "other.example.edu" },
    { email_verified: false },
    { email_verified: "true" },
    { email_verified: undefined },
    { email: "not-an-email" },
  ]) {
    await assert.rejects(verified(transaction, overrides));
  }
});

test("cryptographic verification rejects wrong key, issuer, audience, expiration, iat, nonce and missing claims", async () => {
  const { transaction } = fixture();
  const attacker = await generateKeyPair("RS256");
  await assert.rejects(
    verified(transaction, {}, attacker.privateKey),
    /could not be verified/,
  );
  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [
    { iss: "https://attacker.example" },
    { aud: "another-client" },
    { exp: now - 60 },
    { iat: now + 60 },
    { iat: now - 700 },
    { exp: undefined },
    { iat: undefined },
    { nonce: undefined },
    { nonce: "wrong-nonce" },
    { sub: undefined },
    { sub: "" },
    { azp: "another-client" },
    { aud: [env.GOOGLE_CLIENT_ID, "another-client"], azp: undefined },
  ]) {
    await assert.rejects(
      verified(transaction, overrides),
      undefined,
      `must reject ${JSON.stringify(overrides)}`,
    );
  }
});

test("Microsoft stable subject binds tenant and object id, never mutable email", async () => {
  const { transaction } = fixture("microsoft");
  const identity = await verified(transaction);
  assert.equal(
    identity.subject,
    `${tenant}:oid:bbbbbbbb-cccc-dddd-eeee-ffffffffffff`,
  );
  assert.equal(
    (await verified(transaction, { email: "renamed@school.example.edu" }))
      .subject,
    identity.subject,
  );
  assert.equal(
    (await verified(transaction, { oid: undefined })).subject,
    `${tenant}:sub:stable-test-subject`,
  );
});

test("Microsoft rejects foreign tenants, guests, personal identity providers, missing member claim and invalid email", async () => {
  const { transaction } = fixture("microsoft");
  for (const overrides of [
    { tid: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
    { acct: 1 },
    { acct: undefined },
    { acct: "0" },
    { idp: "live.com" },
    { idp: "https://sts.windows.net/9188040d-6c67-4c5b-b112-36a304b66dad/" },
    { oid: "not-an-object-id" },
    { email_verified: false },
    { email: undefined, preferred_username: "student@school.example.edu" },
  ]) {
    await assert.rejects(verified(transaction, overrides));
  }
});

test("callback rejects expired, future, malformed, mismatched and duplicate transactions before exchanging code", async () => {
  const { transaction } = fixture();
  const callback = `${redirectUri}?code=test-code&state=${transaction.state}`;
  const fetchImpl = () => {
    assert.fail("invalid callbacks must never exchange a code");
  };
  for (const changed of [
    { ...transaction, createdAt: Date.now() - 600_001 },
    { ...transaction, createdAt: Date.now() + 60_000 },
    { ...transaction, verifier: "short" },
    undefined,
  ]) {
    await assert.rejects(
      completeIdentityFlow({
        transaction: changed,
        callbackUrl: callback,
        env,
        redirectUri,
        fetchImpl,
        keySet,
      }),
    );
  }
  for (const callbackUrl of [
    `${redirectUri}?code=test-code&state=wrong`,
    `${callback}&state=${transaction.state}`,
    `${callback}&code=second`,
    `${callback}&iss=https://attacker.example`,
    callback.replace("portal.example.edu", "attacker.example"),
    `${redirectUri}?error=access_denied&state=${transaction.state}`,
    `${redirectUri}?state=${transaction.state}`,
  ]) {
    await assert.rejects(
      completeIdentityFlow({
        transaction,
        callbackUrl,
        env,
        redirectUri,
        fetchImpl,
        keySet,
      }),
    );
  }
});

test("code exchange is server-side and only a verified identity is returned", async () => {
  const { transaction } = fixture();
  const idToken = await signed(transaction);
  let exchanges = 0;
  const identity = await completeIdentityFlow({
    transaction,
    callbackUrl: `${redirectUri}?code=returned-code&state=${transaction.state}`,
    env,
    redirectUri,
    keySet,
    fetchImpl: async (url, options) => {
      exchanges++;
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.body.get("code_verifier"), transaction.verifier);
      assert.equal(options.body.get("client_secret"), env.GOOGLE_CLIENT_SECRET);
      assert.equal(options.body.get("redirect_uri"), redirectUri);
      assert.equal(options.body.get("code"), "returned-code");
      return new Response(
        JSON.stringify({
          id_token: idToken,
          access_token: "sensitive-access-token",
          refresh_token: "sensitive-refresh-token",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  assert.equal(exchanges, 1);
  assert.equal(identity.subject, "stable-test-subject");
  assert.deepEqual(
    Object.keys(identity).sort(),
    ["provider", "subject", "email", "name", "tenant"].sort(),
  );
  assert.ok(!JSON.stringify(identity).includes("sensitive"));
});

test("upstream errors never leak secrets or provider bodies", async () => {
  const { transaction } = fixture();
  for (const fetchImpl of [
    async () =>
      new Response(JSON.stringify({ error: "test-google-secret" }), {
        status: 400,
      }),
    async () => {
      throw new Error("test-google-secret");
    },
    async () =>
      new Response(JSON.stringify({ access_token: "test-google-secret" }), {
        status: 200,
      }),
  ]) {
    await assert.rejects(
      completeIdentityFlow({
        transaction,
        callbackUrl: `${redirectUri}?code=returned-code&state=${transaction.state}`,
        env,
        redirectUri,
        keySet,
        fetchImpl,
      }),
      (error) =>
        error.status === 403 && !error.message.includes("test-google-secret"),
    );
  }
});
