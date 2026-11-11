const normalizeName = value => String(value).trim().replace(/\s+/g, ' ').toLowerCase();

// Corrections change the delivery address, never the sheet's eligibility. A
// removed or renamed source row cannot keep granting access through an override.
export function rosterDirectory(state, directory = state.roster?.directory || []) {
  const corrections = state.rosterEmailCorrections || {};
  const rawEmails = new Set(directory.map(row => row.email));
  const entries = directory.map(row => {
    const prior = Object.entries(corrections).find(([source, correction]) => !rawEmails.has(source) && correction.email === row.email);
    if (prior && normalizeName(row.name) !== normalizeName(prior[1].sourceName)) return null;
    const correction = corrections[row.email];
    if (!correction) return row;
    if (normalizeName(row.name) !== normalizeName(correction.sourceName)) return null;
    if (correction.email !== row.email && rawEmails.has(correction.email)) return null;
    return { ...row, email: correction.email, sourceEmail: row.email };
  }).filter(Boolean);
  // An address cannot stand for two people, including a newly conflicting
  // sheet row. Fail closed until the Chair fixes the source or correction.
  const conflicts = new Set(Object.entries(corrections).filter(([source, row]) =>
    source !== row.email && rawEmails.has(source) && rawEmails.has(row.email)).map(([, row]) => row.email));
  const counts = new Map();
  for (const row of entries) counts.set(row.email, (counts.get(row.email) || 0) + 1);
  return entries.filter(row => !conflicts.has(row.email) && counts.get(row.email) === 1);
}

export const rosterEmails = state => state.roster?.directory
  ? rosterDirectory(state).filter(row => !Array.isArray(state.roster.emails) || state.roster.emails.includes(row.sourceEmail || row.email)).map(row => row.email)
  : state.roster?.emails || [];

