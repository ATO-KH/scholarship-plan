const originalFetch = globalThis.fetch;
const chairId = "aab93409-383f-4d8a-b443-3d940a277153";
const memberId = "d4dc3984-9c89-4ff7-8075-cbe5b2cd18c4";
const respond = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "https://chapter-test.supabase.co")
    return originalFetch(input, options);
  if (url.pathname === "/auth/v1/token") {
    const body = JSON.parse(options.body);
    const id = body.email === "chair@example.edu" ? chairId :
      body.email === "member@example.edu" ? memberId : null;
    if (!id || body.password !== "correct-test-password")
      return respond({ error: "invalid_grant" }, 400);
    return respond({
      access_token: "test-access-token", token_type: "bearer",
      refresh_token: "test-refresh-token", expires_in: 3600,
      user: { id, email: body.email, email_confirmed_at: "2026-09-29T00:00:00Z" },
    });
  }
  if (url.pathname === "/auth/v1/invite")
    return respond({ id: memberId, email: JSON.parse(options.body).email });
  if (url.pathname === "/auth/v1/recover") return respond({});
  if (url.pathname === "/auth/v1/user") {
    const chair = options.headers?.Authorization === "Bearer test-chair-account-token";
    return respond(chair
      ? { id: chairId, email: "chair@example.edu" }
      : { id: memberId, email: "member@example.edu" });
  }
  if (url.pathname.startsWith("/auth/v1/admin/users/") && options.method === "DELETE")
    return respond({});
  return respond({ error: "unexpected mock request" }, 404);
};
