import { createHash, randomBytes, randomUUID } from "node:crypto";

const LEASE_MS = 90_000;
const SEND_COOLDOWN_MS = 60_000;
const EMAIL_LIMIT_COOLDOWN_MS = 60 * 60_000;
export const ROSTER_INVITATION_DEFAULTS = Object.freeze({ tier: 1, credits: 15 });
// Keep aligned with the chapter's verified Supabase mailer_otp_exp setting.
export const INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };

export function invitationVersion(record, memberId = record?.memberId || null) {
  return createHash("sha256").update(JSON.stringify(record ? {
    memberId, email: record.email, authUserId: record.authUserId, status: record.status,
    updatedAt: record.updatedAt, lastSentAt: record.lastSentAt, lastAttemptAt: record.lastAttemptAt,
    linkSentAt: record.linkSentAt, acceptedAt: record.acceptedAt, retryAt: record.retryAt, operation: record.operation,
  } : { memberId })).digest("hex");
}

export function observeInvitationAccount(record, account, time = Date.now()) {
  if (!record || !account || record.authUserId !== account.id || record.email !== account.email) return false;
  let changed = false;
  if (account.confirmed && !record.acceptedAt) {
    record.acceptedAt = account.confirmedAt || new Date(time).toISOString();
    changed = true;
  }
  // A status refresh cannot overwrite a send in progress or move its expiry
  // backward using an older provider snapshot.
  if (!account.confirmed && !(record.operation?.until > time) && account.linkSentAt &&
      Date.parse(account.linkSentAt) > Date.parse(record.linkSentAt || record.lastSentAt || "1970-01-01")) {
    record.linkSentAt = account.linkSentAt;
    changed = true;
  }
  return changed;
}

export function invitationView(record, time = Date.now()) {
  if (!record) return null;
  const busy = (record.operation?.until || 0) > time;
  const deliveryStatus = !busy && record.status === "sending" ? "delivery_unknown"
    : !busy && record.status === "preparing" ? "failed" : record.status;
  const sentAt = record.linkSentAt || record.lastSentAt;
  const expires = sentAt ? Date.parse(sentAt) + INVITATION_LIFETIME_SECONDS * 1000 : NaN;
  const expiresAt = Number.isFinite(expires) ? new Date(expires).toISOString() : null;
  const status = record.acceptedAt ? "accepted" : ["ready", "sent"].includes(deliveryStatus) && expiresAt
    ? expires <= time ? "expired" : "sent" : deliveryStatus;
  return {
    email: record.email, name: record.name, status,
    version: invitationVersion(record), acceptedAt: record.acceptedAt || null,
    expiresAt: status === "accepted" || deliveryStatus === "delivery_unknown" ? null : expiresAt,
    memberId: record.bound ? record.memberId : null,
    loginId: record.bound ? record.alias?.toUpperCase() || null : null,
    lastSentAt: record.lastSentAt || null,
    retryAt: Math.max(record.retryAt || 0, busy ? record.operation.until : 0) || null,
    canReconcile: !busy,
    canResend: !busy && Boolean(record.bound) && ["ready", "sent", "expired", "delivery_unknown"].includes(status) && (record.retryAt || 0) <= time,
    canResendPending: !busy && Boolean(record.bound && record.authUserId) && !record.acceptedAt &&
      ["ready", "sent", "expired", "delivery_unknown"].includes(status) && (record.retryAt || 0) <= time,
    canSendInitial: !busy && Boolean(record.bound) && record.initialEmailEligible !== false && status === "ready" &&
      (!record.lastAttemptAt || record.lastSendRejected === "rate_limit") && !record.lastSentAt && !record.linkSentAt && (record.retryAt || 0) <= time,
    canInviteFromRoster: !busy && record.initialEmailEligible !== false &&
      (record.bound ? status === "ready" : ["preparing", "failed"].includes(status)) &&
      (!record.lastAttemptAt || record.lastSendRejected === "rate_limit") && !record.lastSentAt && !record.linkSentAt && (record.retryAt || 0) <= time,
    message: status === "accepted" ? "Invitation accepted: this account's email has been verified. No reminder is needed."
      : status === "expired" ? "The unused invitation has passed its seven-day window. Send a new link."
      : ["ready", "sent"].includes(status) && record.lastSendRejected === "rate_limit"
      ? (record.retryAt || 0) > time ? "The latest email request was declined because the email service's sending limit was reached. Wait at least one hour before selecting it again."
        : "The latest email request was declined by the email service's sending limit. It can now be selected again."
      : status === "sent" ? "Awaiting acceptance. Ask the member to check their inbox and spam folder."
      : status === "delivery_unknown" ? "The account is ready, but email delivery could not be confirmed. Check the inbox before choosing to resend."
      : status === "ready" ? "The account is ready. No setup email was sent by this check."
      : status === "failed" ? "Account preparation was interrupted. Check account setup to safely resume."
      : "Account setup is in progress. Refresh shortly.",
  };
}

export function invitationList(state, time = Date.now()) {
  return Object.values(state.invitations || {}).map(record => invitationView(record, time))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The durable intent survives request loss and Auth/database split failures.
// All provider effects happen outside transactions; short workspace locks
// serialize reservations and commits across server instances.
export async function runInvitation({
  db, workspace, email, input, action = "create", authorize, guard,
  provider, audit = async () => {}, now = Date.now, expectedVersion,
}) {
  if (!["create", "prepare", "reconcile", "resend", "resend-pending", "send-initial", "invite-roster"].includes(action)) fail(422, "Unknown invitation action.");
  const operationId = randomUUID();
  const load = async () => {
    const row = await db.prepare("SELECT data FROM chapters WHERE workspace=? FOR UPDATE").get(workspace);
    if (!row) fail(404, "Chapter workspace not found.");
    return JSON.parse(row.data);
  };
  const save = state => db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), workspace);
  const identity = (providerName, subject) => db.prepare("SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?")
    .get(workspace, providerName, subject);
  const memberForEmail = () => db.prepare("SELECT * FROM members WHERE workspace=? AND LOWER(email)=?").get(workspace, email);
  const owned = (state) => {
    const record = state.invitations?.[email];
    if (record?.operation?.id !== operationId || record.operation.until <= now())
      fail(409, "Account setup changed. Refresh its status before continuing.");
    return record;
  };
  const update = fn => db.transaction(async () => {
    const state = await load();
    await authorize();
    await guard(state, email);
    const record = owned(state);
    record.updatedAt = new Date(now()).toISOString();
    const result = await fn(record, state);
    await save(state);
    return result;
  });
  let isNewIntent = false;
  const reservation = await db.transaction(async () => {
    const state = await load();
    await authorize();
    await guard(state, email);
    state.invitations ||= {};
    let record = state.invitations[email];
    if ((record?.operation?.until || 0) > now()) fail(409, "This account is already being prepared. Refresh shortly.");
    const existing = await memberForEmail();
    if (existing && (existing.role !== "member" || !existing.active))
      fail(409, "This email belongs to an office or inactive account. Manage that account separately.");
    if (action === "resend-pending") {
      if (!existing) fail(409, "This member's account changed. Refresh invitation status.");
      if (record?.acceptedAt && record.memberId === existing.id)
        return { complete: true, skipped: true, record: structuredClone(record) };
      if (!expectedVersion || expectedVersion !== invitationVersion(record, existing.id))
        fail(409, "This invitation changed after you selected it. Refresh before sending another email.");
      if (record && (!record.bound || !record.authUserId || record.memberId !== existing.id))
        fail(409, "Check this account's setup before sending another invitation.");
      if (!record && !await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='supabase' AND member_id=?")
        .get(workspace, existing.id)) fail(409, "Check this account's setup before sending another invitation.");
    }
    if (record?.status === "sending") record.status = "delivery_unknown";
    // Bulk initial sends cannot provision accounts, replay accepted/uncertain
    // attempts, or become implicit resends after a lost response. A proven
    // rate-limit rejection is selectable again only after its cooldown.
    if (action === "send-initial" && (!existing || !record?.authUserId ||
      !invitationView(record, now())?.canSendInitial))
      fail(409, "This account is not eligible for a first setup email. Refresh its status; review any resend separately.");
    // The roster action may prepare a new account, but cannot adopt an
    // untracked existing member or replay an accepted/ambiguous email.
    const listed = action === "invite-roster" && state.roster?.directory?.find(entry => entry.email === email);
    if (action === "invite-roster") {
      if (!listed || !["active", "new_member"].includes(listed.membership))
        fail(409, "This email is no longer on the eligible chapter roster. Refresh before continuing.");
      if (existing && (!record || existing.id !== record.memberId) || record &&
        (!invitationView(record, now()).canInviteFromRoster || record.bound && (!existing || !record.authUserId)))
        fail(409, "This account cannot receive a first roster invitation. Refresh its status; review any resend separately.");
    }
    // Repeated create/prepare requests never send an email. Sending a prepared
    // account or retrying a delivery always requires the explicit send action.
    if (record && ["create", "prepare"].includes(action) && record.bound)
      return { complete: true, record: structuredClone(record) };
    if (!record) {
      if (!["create", "prepare", "invite-roster"].includes(action) && !existing) fail(404, "No account setup was found for this email.");
      if (existing && action === "create") fail(409, "A member already uses this email address. Use Check account setup or Resend setup email.");
      isNewIntent = true;
      const details = existing || (action === "invite-roster" ? {
        name: listed.name, email, badge: "",
        tier: listed.membership === "new_member" ? 1 : state.tierAssignments?.[email] ?? ROSTER_INVITATION_DEFAULTS.tier,
        credits: ROSTER_INVITATION_DEFAULTS.credits,
      } : input);
      if (!details || details.email.toLowerCase() !== email) fail(422, "Member details are required.");
      const existingAliases = existing ? (await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='login' AND member_id=? ORDER BY subject")
        .all(workspace, existing.id)).map(entry => entry.subject) : [];
      // Reconciliation must preserve the generated portal ID, even when a
      // numeric badge sorts ahead of it. Keep the badge editable separately.
      let alias = existingAliases.find(value => /^kh-[a-f0-9]{10}$/.test(value)) || existingAliases[0];
      const badge = existing ? existingAliases.find(value => value !== alias) || "" : details.badge;
      const badgeIdentity = badge ? await identity("login", badge) : null;
      if (badge && (badgeIdentity && badgeIdentity.member_id !== existing?.id || Object.values(state.invitations)
        .some(entry => entry.email !== email && (entry.badge === badge || entry.alias === badge))))
        fail(409, "A member already uses this badge number.");
      if (!alias) {
        do { alias = `kh-${randomBytes(5).toString("hex")}`; }
        while (await identity("login", alias) || Object.values(state.invitations).some(entry => entry.alias === alias || entry.badge === alias));
      }
      const linked = existing && await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='supabase' AND member_id=?")
        .get(workspace, existing.id);
      record = state.invitations[email] = {
        email, name: details.name, badge: badge || "", tier: details.tier, credits: details.credits,
        memberId: existing?.id || randomUUID(), alias,
        authUserId: linked?.subject || null, bound: Boolean(linked),
        status: "preparing", createdAt: new Date(now()).toISOString(),
      };
    }
    // Persist before contacting Auth so a lost create response remains safely
    // recoverable without adopting an attacker-precreated unconfirmed account.
    record.provenance ||= randomBytes(32).toString("hex");
    if (["resend", "resend-pending"].includes(action) && (record.retryAt || 0) > now())
      fail(429, "Please wait one minute before sending another setup email.");
    record.operation = { id: operationId, until: now() + LEASE_MS };
    record.updatedAt = new Date(now()).toISOString();
    await save(state);
    return { record: structuredClone(record) };
  });
  if (reservation.complete) return { invitation: invitationView(reservation.record, now()), memberId: reservation.record.memberId, ...(reservation.skipped ? { skipped: true } : {}) };

  let sending = false, sendPriorStatus, initialEligibleBeforeSend = false;
  try {
    let account = await provider.find(email);
    let createdAuth = false;
    if (!account) {
      if (reservation.record.authUserId) fail(409, "The linked sign-in account is unavailable. Ask the portal operator to check it.");
      account = await provider.create(email, { version: 1, workspace, nonce: reservation.record.provenance });
      createdAuth = true;
    }
    if (!account?.id || account.email !== email ||
      (reservation.record.authUserId && reservation.record.authUserId !== account.id))
      fail(409, "The sign-in account does not match the saved member. Ask the portal operator to check it.");
    if (!reservation.record.authUserId && !account.confirmed &&
        (account.invitationProof?.version !== 1 || account.invitationProof.workspace !== workspace ||
         account.invitationProof.nonce !== reservation.record.provenance))
      fail(409, "An unconfirmed sign-in already exists for this email and could not be verified as a portal-created account. Ask the portal operator to check it before continuing.");
    await update(async (record, state) => {
      const existing = await memberForEmail();
      if (existing && (existing.id !== record.memberId || existing.role !== "member" || !existing.active))
        fail(409, "The member account changed while setup was in progress.");
      const linked = await identity("supabase", account.id);
      if (linked && linked.member_id !== record.memberId)
        fail(409, "This sign-in is already linked to another member.");
      const memberIdentity = await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='supabase' AND member_id=?")
        .get(workspace, record.memberId);
      if (memberIdentity && memberIdentity.subject !== account.id)
        fail(409, "This member already has a different sign-in account.");
      const listed = state.roster?.directory?.find(entry => entry.email === email);
      const tier = listed?.membership === "new_member" ? 1 : state.tierAssignments?.[email] ?? record.tier;
      if (!existing) await db.prepare("INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES (?,?,?,?,?,?,?,1)")
        .run(workspace, record.memberId, record.name, email, "member", tier, record.credits);
      for (const [kind, subject] of [["supabase", account.id], ["login", record.alias], ...(record.badge ? [["login", record.badge]] : [])]) {
        const found = await identity(kind, subject);
        if (found && found.member_id !== record.memberId) fail(409, "This badge number or sign-in is already linked to another member.");
        if (!found) await db.prepare("INSERT INTO identities VALUES (?,?,?,?)").run(workspace, kind, subject, record.memberId);
      }
      if (!existing && state.tierAssignments) delete state.tierAssignments[email];
      record.name = existing?.name ?? record.name;
      record.tier = existing?.tier ?? tier;
      record.credits = existing?.credits ?? record.credits;
      record.authUserId = account.id;
      record.bound = true;
      observeInvitationAccount(record, account, now());
      // A confirmed identity already has a working account. Bulk first-time
      // invitations must never turn into recovery links for those members.
      record.initialEmailEligible = record.initialEmailEligible !== false && !account.confirmed &&
        !["sent", "sending", "delivery_unknown"].includes(record.status) && !record.lastSentAt &&
        (!record.lastAttemptAt || record.lastSendRejected === "rate_limit");
      // A legacy orphan may already have received a link. Repair it without
      // delivering a surprise second email or resetting its password.
      if (isNewIntent && !createdAuth && action === "create") record.status = "delivery_unknown";
      else if (!["sent", "delivery_unknown"].includes(record.status)) record.status = "ready";
      await audit("roster.invitation_reconcile", record.memberId, `Account ready; ${!existing ? `tier ${tier}; credits ${record.credits}` : "existing member retained"}.`);
    });
    const shouldSend = ["resend", "resend-pending", "send-initial", "invite-roster"].includes(action) || (action === "create" && isNewIntent && createdAuth);
    if (shouldSend) {
      // Mark the attempt before crossing the email boundary. If the server
      // crashes after the provider accepts it, no automatic replay is possible.
      const sendAllowed = await update(async record => {
        const existing = await memberForEmail();
        if (!existing || existing.id !== record.memberId || existing.role !== "member" || !existing.active)
          fail(409, "This member is no longer eligible to receive a setup email.");
        // A member can accept between selection, provider lookup, and this
        // reservation. Pending-only sends must never become password resets.
        if (action === "resend-pending" && (account.confirmed || record.acceptedAt)) return false;
        if (["send-initial", "invite-roster"].includes(action) && (account.confirmed || record.initialEmailEligible === false ||
          record.status !== "ready" || (record.lastAttemptAt && record.lastSendRejected !== "rate_limit") || record.lastSentAt))
          fail(409, "This account no longer qualifies for a first setup email. Refresh its status; review any resend separately.");
        sendPriorStatus = record.status;
        initialEligibleBeforeSend = record.initialEmailEligible !== false && record.status === "ready" &&
          !record.lastSentAt && (!record.lastAttemptAt || record.lastSendRejected === "rate_limit");
        // Consume eligibility durably before the network boundary. Only a
        // proven rejection of this attempt may restore its previous value.
        record.initialEmailEligible = false;
        record.status = "sending";
        delete record.lastSendRejected;
        record.retryAt = now() + SEND_COOLDOWN_MS;
        record.lastAttemptAt = new Date(now()).toISOString();
        record.operation.until = now() + LEASE_MS;
        await audit("roster.invitation_send_started", record.memberId, "Setup email requested by Chair.");
        return true;
      });
      if (!sendAllowed) return await update(record => {
        delete record.operation;
        return { invitation: invitationView(record, now()), memberId: record.memberId, skipped: true };
      });
      sending = true;
      await provider.send(account);
      await update(async record => {
        record.status = "sent";
        record.lastSentAt = new Date(now()).toISOString();
        record.linkSentAt = record.lastAttemptAt;
        await audit("roster.invitation_sent", record.memberId, "Provider accepted setup email; inbox delivery is not verified.");
      });
    }
    return await update(record => {
      delete record.operation;
      return { invitation: invitationView(record, now()), memberId: record.bound ? record.memberId : null };
    });
  } catch (error) {
    // Error bookkeeping must not depend on a still-active initiating session.
    // It can only touch this operation's record, never create membership or mail.
    await db.transaction(async () => {
      const state = await load();
      const record = state.invitations?.[email];
      if (record?.operation?.id !== operationId) return;
      const rejectedByLimit = sending && error.status === 429 && error.emailNotAccepted === true;
      record.status = rejectedByLimit ? sendPriorStatus === "delivery_unknown" ? "delivery_unknown" : record.lastSentAt ? "sent" : "ready" : sending || record.status === "sending" ? "delivery_unknown"
        : record.bound && ["ready", "sent", "delivery_unknown"].includes(record.status) ? record.status : "failed";
      if (rejectedByLimit) {
        record.initialEmailEligible = initialEligibleBeforeSend;
        record.lastSendRejected = "rate_limit";
        record.retryAt = now() + EMAIL_LIMIT_COOLDOWN_MS;
        await audit("roster.invitation_rate_limited", record.memberId, "Email service rejected the setup email due to its rate limit. No automatic retry.");
      }
      record.updatedAt = new Date(now()).toISOString();
      delete record.operation;
      await save(state);
    }).catch(() => {});
    if (error.status) throw error;
    fail(503, sending
      ? "The account is ready, but the email result is unknown. Check account setup and the member's inbox before explicitly resending."
      : "Account setup was interrupted. Use Check account setup to safely resume. No automatic resend will occur.");
  }
}
