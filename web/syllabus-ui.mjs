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
  let items = toItems(syllabi, removals), saving = false;
  container.innerHTML = `<div class="section-heading"><h2>${ownerFilter ? 'Member classes & credits' : 'Class reviews'}</h2><button class="button ghost small" data-refresh-classes type="button">Refresh</button></div><p class="muted">Approve the syllabus and hours together. Open an approved or denied class to correct a decision or its hours. Corrections require a reason and keep the review history.</p><div class="invitation-filters"><div class="field"><label for="class-review-search">Search member or class</label><input id="class-review-search" type="search" autocomplete="off" value="${esc(search)}" placeholder="Search classes"></div><div class="field syllabus-filter"><label for="syllabus-status">Status</label><select id="syllabus-status">${['pending', 'approved', 'denied', 'all'].map(value => `<option value="${value}"${value === selectedFilter ? ' selected' : ''}>${value === 'all' ? 'All classes' : value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></div></div><p class="class-review-result" role="status" aria-live="polite"></p><p class="class-review-count footnote" role="status"></p><div class="syllabus-queue"></div>`;
  container.querySelector('[data-refresh-classes]').onclick = reload;
  container.querySelector('select').onchange = event => { selectedFilter = event.target.value; renderRows(); };
  container.querySelector('#class-review-search').oninput = event => { search = event.target.value; renderRows(); };
  const list = container.querySelector('.syllabus-queue');
  function renderRows() {
    const query = search.trim().toLocaleLowerCase();
    const visible = items.filter(item => (!ownerFilter || item.owner === ownerFilter) && (selectedFilter === 'all' || item.status === selectedFilter) && (!query || `${item.className} ${item.memberName}`.toLocaleLowerCase().includes(query)));
    list.replaceChildren();
    container.querySelector('.class-review-count').textContent = `${visible.length} class ${visible.length === 1 ? 'review' : 'reviews'} in this view`;
    if (!visible.length) list.innerHTML = '<p class="muted">No class reviews in this view. Choose All classes to see previous decisions.</p>';
    for (const item of visible) {
      const removal = item.kind === 'removal', pending = item.status === 'pending', correction = !pending;
      const row = document.createElement('details');
      row.className = 'syllabus-review-card';
      const hours = Number.isFinite(item.credits) ? `${item.credits} credit hours` : 'Credit hours not yet supplied';
      const reviewable = removal || !item.removalPending;
      row.innerHTML = `<summary><span><strong>${esc(item.className)}${removal ? ' · Removal request' : ''}</strong><small>${esc(item.memberName)} · ${esc(hours)}</small></span><span class="status ${esc(item.status)}">${esc(pending ? 'Awaiting review' : item.status)}</span></summary><div class="syllabus-review-content">${removal ? '<p>Approve to remove this class and its approved hours. Existing assignments keep their original syllabus reference.</p>' : `<p><strong>${esc(hours)}</strong>${Number.isFinite(item.approvedCredits) ? ` · ${esc(item.approvedCredits)} hours currently counted` : ' · No approved hours counted'}</p><div class="syllabus-preview"></div>`}${item.removalPending ? '<p class="notice">Review the pending removal request before changing this class.</p>' : ''}${item.reviewNote ? `<p class="review-note">${esc(item.reviewNote)}</p>` : ''}${item.history?.length ? `<details class="class-review-history"><summary>Decision history (${item.history.length})</summary>${item.history.map(entry => `<p><strong>${entry.correction ? 'Correction' : 'Review'} · ${esc(entry.status)} · ${esc(entry.approvedCredits ?? 0)} approved hours</strong><small>${esc(entry.reviewer)} · ${esc(new Date(entry.at).toLocaleString())}</small>${entry.correction ? `<small>Previously ${esc(entry.before.status)} · ${esc(entry.before.approvedCredits ?? 0)} approved hours</small>` : ''}${esc(entry.note || '')}</p>`).join('')}</details>` : ''}${reviewable ? `${correction ? '<button class="button ghost" data-correct-class type="button">Correct decision / hours</button>' : ''}<form class="syllabus-review-form"${correction ? ' hidden' : ''}>${correction ? '<p class="notice info">This replaces the current decision. Denying an approved class removes its approved hours. Pending point estimates update; previously awarded points stay as recorded.</p>' : ''}${!removal ? `<div class="field"><label>Credit hours to approve<input type="number" name="credits" min="0" max="30" step="0.01" required value="${Number.isFinite(item.credits) ? esc(item.credits) : ''}"></label></div>` : ''}<p class="class-credit-change"></p><div class="field"><label>${correction ? 'Reason for correction' : 'Review note'}<textarea name="note" maxlength="1000" placeholder="${correction ? 'Required for every correction' : 'Required for a denial or changed hours'}"></textarea></label></div><div class="syllabus-feedback" role="status"></div><div class="modal-actions"><button class="button danger" type="submit" name="decision" value="denied" formnovalidate>${removal ? 'Keep class' : correction ? 'Save denial' : 'Deny class'}</button><button class="button gold" type="submit" name="decision" value="approved">${removal ? 'Approve removal' : correction ? 'Save approval and hours' : 'Approve class and hours'}</button></div></form>` : ''}</div>`;
      list.append(row);
      row.ontoggle = () => {
        if (!removal && row.open && !row.dataset.loaded) { row.dataset.loaded = 'true'; mountSyllabusPreview(row.querySelector('.syllabus-preview'), item.id, { api, loading, isCurrent: () => valid() && row.isConnected }); }
      };
      const form = row.querySelector('form');
      if (!form) continue;
      const creditInput = form.querySelector('[name="credits"]');
      const creditValue = () => !creditInput || creditInput.value.trim() === '' ? null : Number(creditInput.value);
      const projectedTotal = () => removal ? item.projectedAccountCredits :
        creditValue() === null ? null : Math.round(((item.approvedAccountCredits ?? (item.projectedAccountCredits - item.credits + (item.approvedCredits || 0))) - (item.approvedCredits || 0) + creditValue()) * 100) / 100;
      const updateHours = () => {
        const total = projectedTotal(), value = creditValue();
        const invalid = !removal && (value === null || !Number.isFinite(value) || value < 0 || value > 30 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8);
        form.querySelector('[value="approved"]').disabled = invalid || total > 30;
        form.querySelector('.class-credit-change').textContent = total > 30 ? 'This would exceed the 30-hour account limit. Correct the hours before approving.' : Number.isFinite(total) ? `Account hours: ${item.currentAccountCredits} → ${total} if approved.` : 'Enter the credit hours shown in the syllabus.';
      };
      if (creditInput) creditInput.oninput = updateHours;
      updateHours();
      const edit = row.querySelector('[data-correct-class]');
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
    if (openNext && selectedFilter === 'pending') {
      const first = list.querySelector('details');
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
