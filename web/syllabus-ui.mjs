import { mountFilePreview } from './file-preview-ui.mjs';

export function mountSyllabusPreview(container, id, { api, loading, isCurrent = () => container.isConnected }) {
  return mountFilePreview(container, () => api(`/api/syllabi/${encodeURIComponent(id)}/evidence`), {
    loading, isCurrent, label: 'Syllabus',
  });
}

const queueRevisions = new WeakMap();
export async function mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter = 'pending', search = '', ownerFilter = '', openNext = false, onReviewed = () => {} }) {
  const revision = (queueRevisions.get(container) || 0) + 1;
  queueRevisions.set(container, revision);
  const valid = () => isCurrent() && queueRevisions.get(container) === revision;
  const reload = () => mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter, search, ownerFilter, onReviewed, openNext });
  let syllabi, removals;
  try { ({ syllabi, removals = [] } = await api('/api/syllabi')); }
  catch (error) {
    if (valid()) {
      container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p><button class="button ghost" type="button">Retry loading classes</button>`;
      container.querySelector('button').onclick = reload;
    }
    return;
  }
  if (!valid()) return;
  const toItems = (classes, requests) => [...requests.map(item => ({ ...item, kind: 'removal', status: 'pending' })), ...classes];
  let items = toItems(syllabi, removals), saving = false, nextOwner = '';
  const drafts = new Map(), selected = new Map();
  container.innerHTML = `<div class="section-heading"><h2>${ownerFilter ? 'Member classes & credits' : 'Class reviews'}</h2><button class="button ghost small" data-refresh-classes type="button">Refresh</button></div><p class="muted">Approve the syllabus and hours together. Open an approved or denied class to correct a decision or its hours. Corrections require a reason and keep the review history. Select up to 20 reviewed classes to approve together.</p><div class="invitation-filters"><div class="field"><label for="class-review-search">Search member or class</label><input id="class-review-search" type="search" autocomplete="off" value="${esc(search)}" placeholder="Search classes"></div><div class="field syllabus-filter"><label for="syllabus-status">Status</label><select id="syllabus-status">${['pending', 'approved', 'denied', 'all'].map(value => `<option value="${value}"${value === selectedFilter ? ' selected' : ''}>${value === 'all' ? 'All classes' : value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></div></div><div class="class-batch-bar" hidden><span data-class-selected role="status"></span><button class="button ghost small" data-clear-classes type="button">Clear selection</button><button class="button gold" data-review-classes type="button">Review selected approvals</button></div><div class="class-batch-confirm" hidden></div><p class="class-review-result" role="status" aria-live="polite"></p><p class="class-review-count footnote" role="status"></p><div class="syllabus-queue"></div>`;
  container.querySelector('[data-refresh-classes]').onclick = reload;
  container.querySelector('select').onchange = event => { selectedFilter = event.target.value; renderRows(); };
  container.querySelector('#class-review-search').oninput = event => { search = event.target.value; renderRows(); };
  const list = container.querySelector('.syllabus-queue');
  const batchBar = container.querySelector('.class-batch-bar'), batchPanel = container.querySelector('.class-batch-confirm');
  const draftKey = item => `${item.kind || 'syllabus'}:${item.id || item.classId}`;
  function captureDrafts() {
    for (const row of list.querySelectorAll('[data-draft-key]')) {
      const form = row.querySelector('form');
      if (form) drafts.set(row.dataset.draftKey, { version: row.dataset.version, credits: form.querySelector('[name="credits"]')?.value,
        note: form.querySelector('textarea').value, open: row.open, editing: !form.hidden });
    }
  }
  function updateSelection() {
    for (const [id, version] of selected) if (!items.some(item => item.id === id && item.version === version && item.status === 'pending' && !item.removalPending)) selected.delete(id);
    batchBar.hidden = selected.size === 0;
    container.querySelector('[data-class-selected]').textContent = `${selected.size} selected for approval${selected.size > 20 ? " · Select at most 20 at a time" : ""}`;
    container.querySelector('[data-review-classes]').disabled = selected.size === 0 || selected.size > 20;
    for (const section of list.querySelectorAll('.class-member-group')) {
      const button = section.querySelector('[data-select-member-classes]');
      if (!button) continue;
      const choices = [...section.querySelectorAll('[data-select-class]')];
      button.textContent = choices.every(choice => choice.checked) ? 'Clear this member' : `Select ${choices.length} pending ${choices.length === 1 ? 'class' : 'classes'}`;
    }
    batchPanel.hidden = true;
  }
  container.querySelector('[data-clear-classes]').onclick = () => { selected.clear(); renderRows(); };
  container.querySelector('[data-review-classes]').onclick = () => {
    captureDrafts();
    const chosen = items.filter(item => selected.has(item.id));
    const approvals = chosen.map(item => { const draft = drafts.get(draftKey(item)); return { id: item.id, version: item.version,
      credits: draft?.credits?.trim() ? Number(draft.credits) : null, note: draft?.note?.trim() || '' }; });
    const totals = new Map();
    let issue = '';
    chosen.forEach((item, i) => {
      const entry = approvals[i];
      if (entry.credits === null || !Number.isFinite(entry.credits) || entry.credits < 0 || entry.credits > 30 || Math.abs(entry.credits * 100 - Math.round(entry.credits * 100)) > 1e-8 || (entry.credits !== item.credits && entry.note.length < 5)) issue = 'Check the selected class hours and add a reason for any changed hours.';
      const before = totals.get(item.owner)?.total ?? item.approvedAccountCredits ?? 0;
      totals.set(item.owner, { name: item.memberName, total: Math.round((before - (item.approvedCredits || 0) + (entry.credits || 0)) * 100) / 100 });
    });
    if ([...totals.values()].some(row => row.total > 30)) issue = 'These approvals would exceed a member’s 30-hour limit. Adjust the selected hours first.';
    batchPanel.hidden = false;
    batchPanel.innerHTML = `<h3>Confirm ${chosen.length} class approvals</h3><p>Review every syllabus before confirming. This includes selected classes hidden by your search or status filter.</p><ul>${chosen.map((item, i) => `<li><strong>${esc(item.memberName)} · ${esc(item.className)}</strong> — ${esc(approvals[i].credits ?? 'Missing')} hours${approvals[i].note ? ` · ${esc(approvals[i].note)}` : ''}</li>`).join('')}</ul><p>${[...totals.values()].map(row => `${esc(row.name)}: ${esc(row.total)} approved hours`).join(' · ')}</p><p data-batch-feedback role="status">${esc(issue)}</p><div class="modal-actions"><button class="button ghost" data-cancel-batch type="button">Back to reviews</button><button class="button gold" data-confirm-batch type="button" ${issue ? 'disabled' : ''}>Approve ${chosen.length} classes</button></div>`;
    batchPanel.querySelector('[data-cancel-batch]').onclick = () => { batchPanel.hidden = true; };
    batchPanel.querySelector('[data-confirm-batch]').onclick = async () => {
      if (saving || !valid()) return;
      saving = true;
      const controls = [...container.querySelectorAll('button,input,select,textarea')].map(control => [control, control.disabled]);
      controls.forEach(([control]) => control.disabled = true);
      const feedback = batchPanel.querySelector('[data-batch-feedback]');
      feedback.textContent = 'Saving selected approvals…';
      try {
        const result = await api('/api/syllabi/approve-batch', { method: 'POST', body: { approvals } });
        if (!valid()) return;
        for (const row of result.results) {
          const updated = row.classReviews;
          items = [...items.filter(item => item.owner !== updated.owner), ...toItems(updated.syllabi, updated.removals)];
        }
        selected.clear(); openNext = selectedFilter === 'pending';
        nextOwner = chosen[0]?.owner || chosen[0]?.memberName || '';
        renderRows();
        container.querySelector('.class-review-result').textContent = `${result.approved} classes approved. Credit totals updated.`;
        Promise.resolve().then(() => onReviewed(result)).catch(() => { if (valid()) container.querySelector('.class-review-result').textContent = 'Approvals saved. Refresh member totals to see the latest balance.'; });
      } catch (error) {
        if (valid()) {
          feedback.textContent = `${error.message} Refresh the class list before trying again.`;
          // A lost response may already have saved. Versions prevent replay;
          // require an explicit reload to establish the current result.
          const reloadButton = document.createElement('button'); reloadButton.type = 'button'; reloadButton.className = 'button ghost'; reloadButton.textContent = 'Reload current classes'; reloadButton.onclick = reload;
          feedback.append(reloadButton);
        }
      } finally {
        saving = false; controls.forEach(([control, disabled]) => control.disabled = disabled);
        const confirm = batchPanel.querySelector('[data-confirm-batch]'); if (confirm) confirm.disabled = true;
      }
    };
    batchPanel.querySelector('[data-cancel-batch]').focus();
  };
  function renderRows() {
    captureDrafts();
    const query = search.trim().toLocaleLowerCase();
    const visible = items.filter(item => (!ownerFilter || item.owner === ownerFilter) && (selectedFilter === 'all' || item.status === selectedFilter) && (!query || `${item.className} ${item.memberName}`.toLocaleLowerCase().includes(query)));
    list.replaceChildren();
    container.querySelector('.class-review-count').textContent = `${visible.length} class ${visible.length === 1 ? 'review' : 'reviews'} in this view`;
    if (!visible.length) list.innerHTML = '<p class="muted">No class reviews in this view. Choose All classes to see previous decisions.</p>';
    const groups = new Map();
    for (const item of visible) {
      const key = item.owner || item.memberName || 'former-member';
      if (!groups.has(key)) groups.set(key, { name: item.memberName || 'Former member', items: [] });
      groups.get(key).items.push(item);
    }
    for (const [owner, group] of [...groups].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const section = document.createElement('section'); section.className = 'class-member-group'; section.dataset.classOwner = owner;
      const selectable = group.items.filter(item => item.kind !== 'removal' && item.status === 'pending' && !item.removalPending);
      const allSelected = selectable.length > 0 && selectable.every(item => selected.has(item.id));
      const creditTotal = group.items.find(item => Number.isFinite(item.approvedAccountCredits))?.approvedAccountCredits;
      section.innerHTML = `<div class="class-member-heading"><div><h3>${esc(group.name)}</h3><p>${group.items.length} class ${group.items.length === 1 ? 'request' : 'requests'}${Number.isFinite(creditTotal) ? ` · ${esc(creditTotal)} approved hours` : ''}</p></div>${selectable.length ? `<button class="button ghost small" type="button" data-select-member-classes>${allSelected ? 'Clear this member' : `Select ${selectable.length} pending ${selectable.length === 1 ? 'class' : 'classes'}`}</button>` : ''}</div><div class="class-member-cards"></div>`;
      list.append(section);
      const memberSelection = section.querySelector('[data-select-member-classes]');
      if (memberSelection) memberSelection.onclick = () => {
        if (saving) return;
        const clear = selectable.every(item => selected.has(item.id));
        for (const item of selectable) { if (clear) selected.delete(item.id); else selected.set(item.id, item.version); }
        renderRows();
      };
      const cards = section.querySelector('.class-member-cards');
      for (const item of group.items) {
        const removal = item.kind === 'removal', pending = item.status === 'pending', correction = !pending;
        const row = document.createElement('details');
        row.className = 'syllabus-review-card';
        row.dataset.draftKey = draftKey(item); row.dataset.version = item.version;
        const savedDraft = drafts.get(draftKey(item));
        const draft = savedDraft?.version === item.version ? savedDraft : null;
        const hours = Number.isFinite(item.credits) ? `${item.credits} credit hours` : 'Credit hours not yet supplied';
        const reviewable = removal || !item.removalPending;
        row.innerHTML = `<summary><span><strong>${esc(item.className)}${removal ? ' · Removal request' : ''}</strong><small>${esc(item.memberName)} · ${esc(hours)}</small></span><span class="status ${esc(item.status)}">${esc(pending ? 'Awaiting review' : item.status)}</span></summary><div class="syllabus-review-content">${removal ? '<p>Approve to remove this class and its approved hours. Existing assignments keep their original syllabus reference.</p>' : `<p><strong>${esc(hours)}</strong>${Number.isFinite(item.approvedCredits) ? ` · ${esc(item.approvedCredits)} hours currently counted` : ' · No approved hours counted'}</p><div class="syllabus-preview"></div>`}${item.removalPending ? '<p class="notice">Review the pending removal request before changing this class.</p>' : ''}${item.reviewNote ? `<p class="review-note">${esc(item.reviewNote)}</p>` : ''}${item.history?.length ? `<details class="class-review-history"><summary>Decision history (${item.history.length})</summary>${item.history.map(entry => `<p><strong>${entry.correction ? 'Correction' : 'Review'} · ${esc(entry.status)} · ${esc(entry.approvedCredits ?? 0)} approved hours</strong><small>${esc(entry.reviewer)} · ${esc(new Date(entry.at).toLocaleString())}</small>${entry.correction ? `<small>Previously ${esc(entry.before.status)} · ${esc(entry.before.approvedCredits ?? 0)} approved hours</small>` : ''}${esc(entry.note || '')}</p>`).join('')}</details>` : ''}${reviewable ? `${correction ? '<button class="button ghost" data-correct-class type="button">Correct decision / hours</button>' : ''}<form class="syllabus-review-form"${correction ? ' hidden' : ''}>${correction ? '<p class="notice info">This replaces the current decision. Denying an approved class removes its approved hours. Pending point estimates update; previously awarded points stay as recorded.</p>' : ''}${!removal ? `<div class="field"><label>Credit hours to approve<input type="number" name="credits" min="0" max="30" step="0.01" required value="${Number.isFinite(item.credits) ? esc(item.credits) : ''}"></label></div>` : ''}<p class="class-credit-change"></p><div class="field"><label>${correction ? 'Reason for correction' : 'Review note'}<textarea name="note" maxlength="1000" placeholder="${correction ? 'Required for every correction' : 'Required for a denial or changed hours'}"></textarea></label></div>${pending && !removal ? `<label class="class-select"><input type="checkbox" data-select-class ${selected.has(item.id) ? 'checked' : ''}> Select for batch approval</label>` : ''}<div class="syllabus-feedback" role="status"></div><div class="modal-actions"><button class="button danger" type="submit" name="decision" value="denied" formnovalidate>${removal ? 'Keep class' : correction ? 'Save denial' : 'Deny class'}</button><button class="button gold" type="submit" name="decision" value="approved">${removal ? 'Approve removal' : correction ? 'Save approval and hours' : 'Approve class and hours'}</button></div></form>` : ''}</div>`;
        cards.append(row);
        row.ontoggle = () => {
          if (!removal && row.open && !row.dataset.loaded) { row.dataset.loaded = 'true'; mountSyllabusPreview(row.querySelector('.syllabus-preview'), item.id, { api, loading, isCurrent: () => valid() && row.isConnected }); }
        };
        const form = row.querySelector('form');
        if (!form) continue;
        if (draft) {
          if (form.querySelector('[name="credits"]')) form.querySelector('[name="credits"]').value = draft.credits;
          form.querySelector('textarea').value = draft.note;
          form.hidden = !draft.editing; row.open = draft.open;
        }
        const selector = form.querySelector('[data-select-class]');
        if (selector) selector.onchange = () => { if (selector.checked) selected.set(item.id, item.version); else selected.delete(item.id); updateSelection(); };
        form.addEventListener('input', () => { captureDrafts(); batchPanel.hidden = true; });
        const creditInput = form.querySelector('[name="credits"]');
        const creditValue = () => !creditInput || creditInput.value.trim() === '' ? null : Number(creditInput.value);
        const projectedTotal = () => removal ? item.projectedAccountCredits :
          creditValue() === null ? null : Math.round(((item.approvedAccountCredits ?? (item.projectedAccountCredits - item.credits + (item.approvedCredits || 0))) - (item.approvedCredits || 0) + creditValue()) * 100) / 100;
        const updateHours = () => {
          const total = projectedTotal(), value = creditValue();
          const invalid = !removal && (value === null || !Number.isFinite(value) || value < 0 || value > 30 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8);
          form.querySelector('[value="approved"]').disabled = invalid || total > 30;
          form.querySelector('.class-credit-change').textContent = total > 30 ? 'This would exceed the 30-hour account limit. Correct the hours before approving.' : Number.isFinite(total) ? `Account hours: ${item.currentAccountCredits ?? 'N/A'} → ${total} if approved.` : 'Enter the credit hours shown in the syllabus.';
        };
        if (creditInput) creditInput.oninput = updateHours;
        updateHours();
        const edit = row.querySelector('[data-correct-class]');
        if (edit && draft?.editing) edit.hidden = true;
        if (edit) edit.onclick = () => { edit.hidden = true; form.hidden = false; creditInput?.focus(); };
        form.onsubmit = async event => {
          event.preventDefault();
          if (saving || form.dataset.saved) return;
          const decision = event.submitter?.value, note = form.querySelector('textarea').value.trim(), feedback = form.querySelector('.syllabus-feedback');
          if (!['approved', 'denied'].includes(decision)) return;
          if (decision === 'approved' && form.querySelector('[value="approved"]').disabled) return;
          if ((correction || decision === 'denied' || !removal && creditValue() !== item.credits) && note.length < 5) { feedback.textContent = 'Explain the decision or changed hours in at least 5 characters.'; return; }
          saving = true;
          const controls = [...container.querySelectorAll('button,input,select,textarea')].map(control => [control, control.disabled]);
          controls.forEach(([control]) => control.disabled = true);
          feedback.innerHTML = loading('Saving class review…', true);
          try {
            const endpoint = removal ? `/api/classes/${encodeURIComponent(item.classId)}/removal-review` : `/api/syllabi/${encodeURIComponent(item.id)}/${correction ? 'revise' : 'review'}`;
            const result = await api(endpoint, { method: 'POST', body: { decision, note, version: item.version, ...(!removal && decision === 'approved' ? { credits: creditValue() } : {}) } });
            if (!valid()) return;
            form.dataset.saved = 'true';
            if (result.classReviews) {
              const updated = result.classReviews;
              items = [...items.filter(row => row.owner !== updated.owner), ...toItems(updated.syllabi, updated.removals)];
              openNext = pending && selectedFilter === 'pending';
              nextOwner = item.owner || item.memberName || '';
              renderRows();
              container.querySelector('.class-review-result').textContent = `${item.className}: ${correction ? 'correction' : 'decision'} saved. ${result.member?.credits ?? result.syllabus?.currentAccountCredits ?? ''} account credit hours.`;
            } else { openNext = true; await reload(); }
            // Refresh navigation without holding up the next review or retrying a saved decision.
            Promise.resolve().then(() => onReviewed(result)).catch(() => {
              if (isCurrent()) container.querySelector('.class-review-result').textContent = 'Decision saved. Refresh member totals to see the latest balance.';
            });
          } catch (error) {
            if (valid()) {
              feedback.textContent = error.message;
              if (error.status === 409) {
                const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button ghost'; retry.textContent = 'Reload current classes'; retry.onclick = reload;
                feedback.append(retry);
              }
            }
          } finally { saving = false; controls.forEach(([control, disabled]) => control.disabled = disabled); }
        };
      }
    }
    updateSelection();
    if (openNext && selectedFilter === 'pending') {
      const nextGroup = [...list.querySelectorAll('.class-member-group')].find(section => section.dataset.classOwner === nextOwner);
      const first = nextGroup?.querySelector('.syllabus-review-card') || list.querySelector('.syllabus-review-card');
      if (first) { first.open = true; first.querySelector('summary').focus(); }
      openNext = false;
    }
  }
  renderRows();
}

export function mountSubmissionSyllabus(container, syllabus, options) {
  if (!syllabus) {
    container.innerHTML = '<p class="footnote">No syllabus was linked when this assignment was submitted.</p>';
    return;
  }
  container.innerHTML = `<details class="syllabus-reference"><summary>Class syllabus · ${options.esc(syllabus.className)}</summary><p class="footnote">Syllabus version linked when this assignment was submitted.</p><div class="syllabus-preview"></div></details>`;
  const details = container.querySelector('details');
  details.ontoggle = () => { if (details.open && !details.dataset.loaded) { details.dataset.loaded = 'true'; mountSyllabusPreview(details.querySelector('.syllabus-preview'), syllabus.id, options); } };
}
