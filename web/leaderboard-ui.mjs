const places = { 1: ['gold', '1st'], 2: ['silver', '2nd'], 3: ['bronze', '3rd'] };
const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
const crown = `<svg class="podium-crown" viewBox="0 0 72 54" aria-hidden="true" focusable="false">
  <path d="m10 17 14 11L36 7l12 21 14-11-5 26H15Z"/>
  <path d="M15 43h42v7H15Z"/>
  <circle cx="10" cy="15" r="3"/><circle cx="36" cy="5" r="3"/><circle cx="62" cy="15" r="3"/>
</svg>`;

export function leaderGraphic(lead, esc) {
  if (!lead || !(lead.points > 0)) return '';
  return `<section class="leader-honor" aria-labelledby="leader-honor-title">
    <svg class="leader-emblem" viewBox="0 0 160 160" fill="none" aria-hidden="true" focusable="false">
      <path d="M80 7 143 43v74l-63 36-63-36V43Z" stroke="currentColor" stroke-width="1.5"/>
      <path d="M58 45h44v19c0 18-9 28-22 28S58 82 58 64Z" stroke="currentColor" stroke-width="3"/>
      <path d="M57 51H43v12c0 12 7 18 20 18m40-30h14v12c0 12-7 18-20 18M80 93v18m-15 8h30m-30 0v-7h30v7" stroke="currentColor" stroke-width="3"/>
      <path d="m80 52 3 7 8 1-6 6 1 8-6-4-6 4 1-8-6-6 8-1Z" fill="currentColor"/>
      <path d="M48 113c-16-11-24-29-21-49m5 24-11-7m16 21-13-3m22 15-13 1m79-2c16-11 24-29 21-49m-5 24 11-7m-16 21 13-3m-22 15 13 1" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>
      <text x="80" y="139" fill="currentColor" text-anchor="middle" font-family="Georgia,serif" font-size="12" letter-spacing="3">ΑΤΩ</text>
    </svg>
    <div class="leader-honor-copy"><p class="eyebrow">KAPPA ETA · SCHOLARSHIP</p>
      <h2 id="leader-honor-title">${lead.shared ? 'Sharing the lead.' : 'Leading the chapter.'}</h2>
      <p>${lead.shared ? 'You’re tied for first' : 'You’re in first place'} with <strong>${esc(number(lead.points))} approved points.</strong></p>
      <a href="#leaderboard">View the leaderboard <span aria-hidden="true">→</span></a>
    </div>
  </section>`;
}

export async function mountLeaderHonor(container, { api, esc, isCurrent }) {
  try {
    const view = await api('/api/leaderboard');
    if (isCurrent()) container.innerHTML = leaderGraphic(view.yourLead, esc);
  } catch {
    // Recognition is optional; a failed lookup must not block the member's work.
    if (isCurrent()) container.replaceChildren();
  }
}

export async function mountLeaderboard(container, { api, esc, loading, isCurrent }) {
  let members = [], pending = false, loaded = false;
  container.innerHTML = `<div class="leaderboard-toolbar">
    <div class="field"><label for="leaderboard-search">Find a member</label><input type="search" id="leaderboard-search" placeholder="Search names" autocomplete="off"></div>
    <button class="button ghost" type="button" data-refresh>Refresh points</button>
  </div><p class="leaderboard-feedback" role="status" aria-live="polite"></p><div class="leaderboard-results" aria-busy="true"></div>`;
  const search = container.querySelector('input'), refresh = container.querySelector('[data-refresh]');
  const results = container.querySelector('.leaderboard-results'), feedback = container.querySelector('.leaderboard-feedback');
  function paint() {
    const query = search.value.trim().toLocaleLowerCase();
    const shown = members.filter(member => member.name.toLocaleLowerCase().includes(query));
    feedback.textContent = `${shown.length} ${shown.length === 1 ? 'member' : 'members'}${query ? ' found' : ''}`;
    if (!shown.length) {
      results.innerHTML = `<div class="empty"><h3>${members.length ? 'No matching members' : 'No members yet'}</h3><p>${members.length ? 'Try another name.' : 'Active chapter members will appear here.'}</p></div>`;
      return;
    }
    const podium = [1, 2, 3].map(place => {
      const winners = shown.filter(member => member.place === place);
      if (!winners.length) return '';
      const [metal, label] = places[place];
      const tied = members.filter(member => member.place === place).length > 1;
      return `<section class="podium-place podium-place-${place} medal-${metal}" aria-label="${label} place, ${metal}${tied ? ', tied' : ''}">
        <div class="podium-names">${winners.map(member => `<div class="podium-member${member.isYou ? ' leaderboard-you' : ''}">${place === 1 ? crown : ''}<strong>${esc(member.name)}</strong>${member.isYou ? '<span class="leaderboard-you-label">You</span>' : ''}</div>`).join('')}</div>
        <div class="podium-step"><h3>${label}</h3><p><strong>${esc(number(winners[0].points))}</strong><span>points${tied ? ' · tied' : ''}</span></p></div>
      </section>`;
    }).join('');
    const rest = shown.filter(member => !places[member.place]);
    results.innerHTML = `${podium ? `<div class="leaderboard-podium" role="group" aria-label="Top three places">${podium}</div>` : ''}${rest.length ? `<section class="leaderboard-list-section"><h3>Member points</h3><ul class="leaderboard-list" aria-label="Member points, highest first">${rest.map(member => `<li${member.isYou ? ' class="leaderboard-you"' : ''}><div class="leaderboard-identity"><strong>${esc(member.name)}</strong>${member.isYou ? '<span class="leaderboard-you-label">You</span>' : ''}</div><span class="leaderboard-points"><strong>${esc(number(member.points))}</strong><span>points</span></span></li>`).join('')}</ul></section>` : ''}`;
  }
  async function load() {
    if (pending || !isCurrent()) return;
    pending = true; refresh.disabled = true; search.disabled = true;
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = loading('Loading chapter points…', true);
    feedback.textContent = '';
    try {
      const view = await api('/api/leaderboard');
      if (!isCurrent()) return;
      members = view.members;
      loaded = true;
      paint();
    } catch (error) {
      if (!isCurrent()) return;
      loaded = false;
      results.innerHTML = '<p>Points are unavailable. Select Refresh points to try again.</p>';
      feedback.textContent = error.message;
    } finally {
      pending = false;
      if (isCurrent()) { refresh.disabled = false; search.disabled = !loaded; results.setAttribute('aria-busy', 'false'); }
    }
  }
  search.addEventListener('input', () => { if (!pending && loaded && isCurrent()) paint(); });
  refresh.addEventListener('click', load);
  await load();
}
