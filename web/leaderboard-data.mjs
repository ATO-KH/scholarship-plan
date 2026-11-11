import { roundPoints } from './point-adjustment-data.mjs';
// Chapter-visible data only. Never return member records or submission details.
export function leaderboardView(state, members, currentId) {
  const entries = new Map(members
    .filter(member => member.role === 'member' && member.active && !member.email?.endsWith('@pilot.invalid'))
    .map(member => [member.id, { name: member.name, points: 0, isYou: member.id === currentId }]));
  // Count awards once, including Chair adjustments, without recalculating historical scores.
  for (const item of state.submissions || []) {
    const entry = entries.get(item.owner);
    if (entry && item.status === 'approved') entry.points = roundPoints(entry.points + item.awarded);
  }
  for (const item of state.pointAdjustments || []) {
    const entry = entries.get(item.owner);
    if (entry) entry.points = roundPoints(entry.points + item.delta);
  }
  const ordered = [...entries.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'en'));
  let place = 0;
  const rows = ordered.map((entry, index) => {
    if (index === 0 || entry.points !== ordered[index - 1].points) place = index + 1;
    // Equal scores share a place (1, 1, 3). No medals before points are earned.
    return { ...entry, place: entry.points > 0 && place <= 3 ? place : null };
  });
  const leaders = rows.filter(entry => entry.place === 1);
  const you = leaders.find(entry => entry.isYou);
  return { members: rows, yourLead: you ? { points: you.points, shared: leaders.length > 1 } : null };
}
