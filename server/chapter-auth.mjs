import { createClient } from "@supabase/supabase-js";

const authOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};

export function chapterAuthConfigured(env = process.env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    return (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      /^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(
        env.SUPABASE_PUBLISHABLE_KEY || "",
      ) &&
      /^sb_secret_[A-Za-z0-9_-]{16,}$/.test(env.SUPABASE_SECRET_KEY || "")
    );
  } catch {
    return false;
  }
}

export function chairAccountConfigured(env = process.env) {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.CHAIR_AUTH_USER_ID || "") &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.CHAIR_ACCOUNT_EMAIL || "")
  );
}

function clients(env) {
  if (!chapterAuthConfigured(env))
    throw Error("Chapter account authentication is not configured.");
  return {
    publicClient: createClient(
      env.SUPABASE_URL,
      env.SUPABASE_PUBLISHABLE_KEY,
      authOptions,
    ),
    adminClient: createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SECRET_KEY,
      authOptions,
    ),
  };
}

export async function verifyPassword(env, email, password) {
  const { publicClient } = clients(env);
  const { data, error } = await publicClient.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data?.user?.id || !data.user.email_confirmed_at) return null;
  return { id: data.user.id, email: data.user.email?.toLowerCase() };
}

export async function inviteAccount(env, email, redirectTo) {
  const { adminClient } = clients(env);
  const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  });
  if (error || !data?.user?.id)
    throw Error("The invitation could not be sent. Check the email service and account status.");
  return data.user.id;
}

export async function sendPasswordReset(env, email, redirectTo) {
  const { publicClient } = clients(env);
  const { error } = await publicClient.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  if (error) throw Error("Password reset email could not be sent.");
}

export async function userForAccountToken(env, accessToken) {
  const { publicClient } = clients(env);
  const { data: verified, error: verifyError } =
    await publicClient.auth.getUser(accessToken);
  if (verifyError || !verified?.user?.id) return null;
  return { id: verified.user.id, email: verified.user.email?.toLowerCase() };
}

export async function setPasswordWithToken(env, accessToken, password, expectedUserId) {
  if (!expectedUserId) return null;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (data?.id !== expectedUserId) return null;
  return { id: data.id, email: data.email?.toLowerCase() };
}

export async function setPasswordByAdmin(env, userId, password) {
  const { adminClient } = clients(env);
  const { data, error } = await adminClient.auth.admin.updateUserById(userId, { password });
  if (error || data?.user?.id !== userId)
    throw Error("The password could not be changed. Try again shortly or request an email reset.");
  return data.user.id;
}
