export async function mountSyllabusPreview(container, id, { api, esc, loading, isCurrent = () => container.isConnected }) {
  container.innerHTML = loading('Loading syllabus…', true);
  try {
    const file = await api(`/api/syllabi/${encodeURIComponent(id)}/evidence`);
    if (!isCurrent() || !container.isConnected) return;
    let url = file.previewUrl;
    if (file.mime === 'application/pdf' && /^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(url)) {
      const bytes = Uint8Array.from(atob(url.split(',')[1]), char => char.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const observer = new MutationObserver(() => { if (!container.isConnected) { URL.revokeObjectURL(url); observer.disconnect(); } });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    container.replaceChildren();
    const label = document.createElement('p');
    label.className = 'footnote'; label.textContent = file.name;
    const pdf = file.mime === 'application/pdf';
    const preview = document.createElement(pdf ? 'iframe' : 'img');
    preview.className = pdf ? 'inline-evidence-pdf' : 'inline-evidence-image';
    if (preview.tagName === 'IFRAME') preview.title = `Syllabus: ${file.name}`;
    else preview.alt = `Syllabus: ${file.name}`;
    preview.src = url;
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = pdf ? 'Open PDF' : 'Open full size'; link.className = 'table-link';
    container.append(label, link);
    if (pdf && navigator.pdfViewerEnabled === false) {
      const hint = document.createElement('p');
      hint.className = 'footnote'; hint.textContent = 'Open the PDF to view this syllabus.';
      container.append(hint);
    } else container.append(preview);
  } catch (error) {
    if (!isCurrent() || !container.isConnected) return;
    container.innerHTML = `<p class="error">${esc(error.message)}</p><button class="button ghost" type="button">Retry syllabus preview</button>`;
    container.querySelector('button').onclick = () => mountSyllabusPreview(container, id, { api, esc, loading, isCurrent });
  }
}

const queueRevisions = new WeakMap();
export async function mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter = 'pending' }) {
  const revision = (queueRevisions.get(container) || 0) + 1;
  queueRevisions.set(container, revision);
  const valid = () => isCurrent() && queueRevisions.get(container) === revision;
  let syllabi;
  try { ({ syllabi } = await api('/api/syllabi')); }
  catch (error) {
    if (valid()) {
      container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p><button class="button ghost" type="button">Retry loading syllabi</button>`;
      container.querySelector('button').onclick = () => mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter });
    }
    return;
  }
  if (!valid()) return;
  const visible = syllabi.filter(item => selectedFilter === 'all' || item.status === selectedFilter);
  container.innerHTML = `<div class="section-heading"><h2>Syllabi</h2><div class="field syllabus-filter"><label for="syllabus-status">Status</label><select id="syllabus-status">${['pending', 'approved', 'denied', 'all'].map(value => `<option value="${value}"${value === selectedFilter ? ' selected' : ''}>${value === 'all' ? 'All syllabi' : value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select></div></div><div class="syllabus-queue"></div>`;
  const reload = () => mountSyllabusQueue(container, { api, esc, loading, isCurrent, selectedFilter });
  container.querySelector('select').onchange = event => { selectedFilter = event.target.value; container.querySelector('.syllabus-queue').innerHTML = loading('Loading syllabi…'); reload(); };
  const list = container.querySelector('.syllabus-queue');
  if (!visible.length) list.innerHTML = '<p class="muted">No syllabi in this view.</p>';
  for (const item of visible) {
    const row = document.createElement('details');
    row.className = 'syllabus-review-card';
    row.innerHTML = `<summary><span><strong>${esc(item.className)}</strong><small>${esc(item.memberName)}</small></span><span class="status ${esc(item.status)}">${esc(item.status === 'pending' ? 'Awaiting review' : item.status)}</span></summary><div class="syllabus-review-content"><div class="syllabus-preview"></div>${item.reviewNote ? `<p class="review-note">${esc(item.reviewNote)}</p>` : ''}${item.status === 'pending' ? '<form class="syllabus-review-form"><div class="field"><label>Review note<textarea name="note" maxlength="1000" placeholder="Required if the syllabus is denied"></textarea></label></div><div class="syllabus-feedback" role="status"></div><div class="modal-actions"><button class="button danger" type="submit" name="decision" value="denied">Deny syllabus</button><button class="button gold" type="submit" name="decision" value="approved">Approve syllabus</button></div></form>' : ''}</div>`;
    list.append(row);
    row.ontoggle = () => {
      if (row.open && !row.dataset.loaded) { row.dataset.loaded = 'true'; mountSyllabusPreview(row.querySelector('.syllabus-preview'), item.id, { api, esc, loading, isCurrent: valid }); }
    };
    const form = row.querySelector('form');
    if (form) form.onsubmit = async event => {
      event.preventDefault();
      const decision = event.submitter?.value, note = form.querySelector('textarea').value.trim(), feedback = form.querySelector('.syllabus-feedback');
      if (!decision) return;
      if (decision === 'denied' && note.length < 5) { feedback.textContent = 'Explain what needs to change in at least 5 characters.'; return; }
      const controls = [...form.querySelectorAll('button,textarea')]; controls.forEach(control => control.disabled = true);
      feedback.innerHTML = loading('Saving syllabus review…', true);
      try { await api(`/api/syllabi/${encodeURIComponent(item.id)}/review`, { method: 'POST', body: { decision, note, version: item.version } }); if (valid()) await reload(); }
      catch (error) { if (valid()) feedback.textContent = error.message; }
      finally { controls.forEach(control => control.disabled = false); }
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
