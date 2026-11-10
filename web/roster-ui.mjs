export function mountRosterMembers(container, members, { esc, state, chapterAuth, currentUserId }) {
  const active = member => member.active !== false && member.active !== 0;
  container.innerHTML = `<div class="section-heading"><h2>Members</h2><span class="muted">${members.filter(member => member.role === 'member' && active(member)).length} active members</span></div><div class="invitation-filters"><div class="field"><label for="roster-search">Find a member</label><input id="roster-search" type="search" value="${esc(state.search || '')}" placeholder="Name, email or sign-in ID"></div><div class="field"><label for="roster-filter">Show</label><select id="roster-filter"><option value="active">Active members</option><option value="inactive">Inactive accounts</option><option value="all">All accounts</option></select></div></div><p data-roster-count class="muted" role="status"></p><div data-roster-results></div><nav class="submission-pagination" aria-label="Member pages"><button class="button ghost small" data-roster-prev type="button">Previous</button><span data-roster-page></span><button class="button ghost small" data-roster-next type="button">Next</button></nav>`;
  const search = container.querySelector('#roster-search'), filter = container.querySelector('#roster-filter');
  filter.value = state.filter || 'active';
  const matches = member => `${member.name} ${member.email || ''} ${(member.identities || []).filter(identity => identity.provider === 'login').map(identity => identity.subject).join(' ')}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()) &&
    (filter.value === 'all' || (filter.value === 'inactive' ? !active(member) : active(member) && member.role === 'member'));
  function render() {
    const visible = members.filter(matches), pages = Math.max(1, Math.ceil(visible.length / 50));
    state.page = Math.max(0, Math.min(state.page || 0, pages - 1));
    const rows = visible.slice(state.page * 50, (state.page + 1) * 50);
    container.querySelector('[data-roster-count]').textContent = `${visible.length} ${visible.length === 1 ? 'account' : 'accounts'} found`;
    container.querySelector('[data-roster-results]').innerHTML = rows.length ? `<div class="table-wrap"><table class="roster-member-table"><thead><tr><th>Member</th><th>Points</th><th>Credits / tier</th><th>Manage</th></tr></thead><tbody>${rows.map(member => {
      const editable = active(member) && member.role === 'member';
      return `<tr><td><strong>${esc(member.name)}</strong><small>${esc(member.email || '')}</small><small>${!active(member) ? 'Inactive' : member.role === 'chair' ? 'Scholarship Chair office' : (member.identities || []).filter(identity => identity.provider === 'login').map(identity => esc(identity.subject.toUpperCase())).join(' · ')}</small></td><td>${member.role === 'member' ? `<strong>${esc(member.approved ?? 0)} / ${esc(member.goal)}</strong><small>${esc(member.pending ?? 0)} submissions pending</small>${editable ? `<button class="table-link" data-action="adjust-points" data-id="${esc(member.id)}">Adjust points</button>` : ''}` : '—'}</td><td>${member.role === 'member' ? `<strong>${esc(member.credits)} credits</strong><small>Tier ${esc(member.tier)}${member.creditsManaged ? ' · From approved classes' : ' · Starting hours'}</small>${editable ? `<button class="table-link" data-action="manage-credits" data-id="${esc(member.id)}">Manage credits</button>` : ''}` : '—'}</td><td><div class="roster-row-actions">${editable ? `<button class="button ghost small" data-action="edit-academic-settings" data-id="${esc(member.id)}">Account settings</button>${member.pending ? `<button class="table-link" data-action="review-member" data-id="${esc(member.id)}">Review submissions</button>` : ''}` : ''}${active(member) && member.id !== currentUserId ? `<details class="roster-access-menu"><summary>Access options</summary>${chapterAuth ? `<button class="table-link" data-action="reset-member-password" data-id="${esc(member.id)}">Send password reset</button>` : ''}<button class="table-link" data-action="deactivate-member" data-id="${esc(member.id)}">Deactivate account</button></details>` : member.id === currentUserId ? 'Current account' : ''}</div></td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="empty">No matching members. Try a different name or choose All accounts.</p>';
    container.querySelector('nav').hidden = pages === 1;
    container.querySelector('[data-roster-page]').textContent = `Page ${state.page + 1} of ${pages}`;
    container.querySelector('[data-roster-prev]').disabled = state.page === 0;
    container.querySelector('[data-roster-next]').disabled = state.page === pages - 1;
  }
  search.oninput = filter.onchange = () => { state.search = search.value; state.filter = filter.value; state.page = 0; render(); };
  container.querySelector('[data-roster-prev]').onclick = () => { state.page--; render(); };
  container.querySelector('[data-roster-next]').onclick = () => { state.page++; render(); };
  render();
}
