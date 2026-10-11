import { mountFilePreview } from './file-preview-ui.mjs';

export function mountSyllabusPreview(container, id, { api, loading, isCurrent = () => container.isConnected }) {
  return mountFilePreview(container, () => api(`/api/syllabi/${encodeURIComponent(id)}/evidence`), {
    loading, isCurrent, label: 'Syllabus',
  });
}

const queueRevisions = new WeakMap();
export async function mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter = 'pending' }) {
  const revision = (queueRevisions.get(container) || 0) + 1;
  queueRevisions.set(container, revision);
  const valid = () => isCurrent() && queueRevisions.get(container) === revision;
  let syllabi, removals;
  try { ({ syllabi, removals = [] } = await api('/api/syllabi')); }
  catch (error) {
    if (valid()) {
      container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p><button class="button ghost" type="button">Retry loading classes</button>`;
      container.querySelector('button').onclick = () => mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter });
    }
    return;
  }
  if (!valid()) return;
  const visible = [
    ...removals.map(item => ({ ...item, kind: 'removal', status: 'pending' })),
    ...syllabi,
  ].filter(item => selectedFilter === 'all' || item.status === selectedFilter);
  container.innerHTML = `<div class="section-heading"><h2>Classes</h2><div class="field syllabus-filter"><label for="syllabus-status">Status</label><select id="syllabus-status">${['pending', 'approved', 'denied', 'all'].map(value => `<option value="${value}"${value === selectedFilter ? ' selected' : ''}>${value === 'all' ? 'All classes' : value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></div></div><div class="syllabus-queue"></div>`;
  const reload = () => mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter });
  container.querySelector('select').onchange = event => { selectedFilter = event.target.value; container.querySelector('.syllabus-queue').innerHTML = loading('Loading classes…'); reload(); };
  const list = container.querySelector('.syllabus-queue');
  if (!visible.length) list.innerHTML = '<p class="muted">No class reviews in this view.</p>';
  for (const item of visible) {
    const removal = item.kind === 'removal';
    const missingCredits = !Number.isFinite(item.credits);
    const excessiveTotal = Number.isFinite(item.projectedAccountCredits) && item.projectedAccountCredits > 30;
    const row = document.createElement('details');
    row.className = 'syllabus-review-card';
    const hours = missingCredits ? 'Credit hours not yet supplied' : `${item.credits} credit hours`;
    const change = Number.isFinite(item.currentAccountCredits) && Number.isFinite(item.projectedAccountCredits)
      ? `<p class="class-credit-change">Account hours: <strong>${esc(item.currentAccountCredits)}</strong> → <strong>${esc(item.projectedAccountCredits)}</strong> if approved. Verify the complete class list before awarding points.</p>` : '';
    const pending = item.status === 'pending';
    const reviewable = pending && (removal || !item.removalPending);
    row.innerHTML = `<summary><span><strong>${esc(item.className)}${removal ? ' · Removal request' : ''}</strong><small>${esc(item.memberName)} · ${esc(hours)}</small></span><span class="status ${esc(item.status)}">${esc(pending ? 'Awaiting review' : item.status)}</span></summary><div class="syllabus-review-content">${removal ? '<p>Approve to remove this class and its approved hours. Existing assignments keep their original syllabus reference.</p>' : `<p><strong>${esc(hours)}</strong>${Number.isFinite(item.approvedCredits) && pending ? ` · ${esc(item.approvedCredits)} hours currently approved for this class` : ''}</p><div class="syllabus-preview"></div>`}${reviewable ? change : ''}${pending && !removal && item.removalPending ? '<p class="notice">Review the pending removal request before reviewing changes to this class.</p>' : ''}${pending && missingCredits && !removal ? '<p class="notice">Ask the member to add credit hours and resubmit this class from My profile before approving.</p>' : ''}${pending && excessiveTotal ? '<p class="error">This would exceed the 30-hour account limit. Check the member’s classes before approving.</p>' : ''}${item.reviewNote ? `<p class="review-note">${esc(item.reviewNote)}</p>` : ''}${reviewable ? `<form class="syllabus-review-form"><div class="field"><label>Review note<textarea name="note" maxlength="1000" placeholder="Required when denying a request"></textarea></label></div><div class="syllabus-feedback" role="status"></div><div class="modal-actions"><button class="button danger" type="submit" name="decision" value="denied">${removal ? 'Keep class' : 'Deny class'}</button><button class="button gold" type="submit" name="decision" value="approved"${(!removal && missingCredits) || excessiveTotal ? ' disabled' : ''}>${removal ? 'Approve removal' : 'Approve class and hours'}</button></div></form>` : ''}</div>`;
    list.append(row);
    row.ontoggle = () => {
      if (!removal && row.open && !row.dataset.loaded) { row.dataset.loaded = 'true'; mountSyllabusPreview(row.querySelector('.syllabus-preview'), item.id, { api, esc, loading, isCurrent: valid }); }
    };
    const form = row.querySelector('form');
    if (form) form.onsubmit = async event => {
      event.preventDefault();
      const decision = event.submitter?.value, note = form.querySelector('textarea').value.trim(), feedback = form.querySelector('.syllabus-feedback');
      if (!decision || decision === 'approved' && ((!removal && missingCredits) || excessiveTotal)) return;
      if (decision === 'denied' && note.length < 5) { feedback.textContent = 'Explain the decision in at least 5 characters.'; return; }
      const controls = [...form.querySelectorAll('button,textarea')].map(control => [control, control.disabled]);
      controls.forEach(([control]) => control.disabled = true);
      feedback.innerHTML = loading('Saving class review…', true);
      try {
        const endpoint = removal ? `/api/classes/${encodeURIComponent(item.classId)}/removal-review` : `/api/syllabi/${encodeURIComponent(item.id)}/review`;
        await api(endpoint, { method: 'POST', body: { decision, note, version: item.version } });
        if (valid()) await reload();
      }
      catch (error) { if (valid()) feedback.textContent = error.message; }
      finally { controls.forEach(([control, disabled]) => control.disabled = disabled); }
    };
  }
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
