// Explicit Chair-created pilot identities; no email-domain-wide exemption.
export function pilotEligible(state, user, now = Date.now()) {
  const pilot = state.pilotAccounts?.find(entry => entry.id === user?.id);
  return Boolean(user?.role === "member" && user.active &&
    user.email?.endsWith("@pilot.invalid") && pilot &&
    Number.isFinite(Date.parse(pilot.expiresAt)) && now < Date.parse(pilot.expiresAt));
}
