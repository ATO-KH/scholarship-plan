import { readImage, uploadImage } from './credit-ui.mjs';
import { mountSyllabusPreview } from './syllabus-ui.mjs';

export async function mountProfile(container, { api, esc, loading, isCurrent, sandbox = false, config = {} }) {
  const { classes, accountCredits, approvedCredits, creditsManaged } = await api('/api/classes');
  if (!isCurrent()) return;
  const formatHours = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const hasHours = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  const total = hasHours(accountCredits) ? accountCredits : approvedCredits;
  container.innerHTML = `<h2>My classes</h2><p class="muted">Add each class’s credit hours and syllabus. The Chair approves both before the class’s hours count and assignments unlock.</p>${hasHours(total) ? `<p class="class-credit-total"><strong>${esc(formatHours(total))} approved credit hours</strong>${creditsManaged ? '<br><small>From your approved classes.</small>' : '<br><small>Your current account total stays in place until the Chair approves class credit hours.</small>'}</p>` : ''}<div class="profile-class-list"></div><button class="button ghost" type="button" id="add-class">Add class</button><div class="class-editor" hidden></div><div class="profile-feedback" role="status"></div>`;
  const list = container.querySelector('.profile-class-list'), editor = container.querySelector('.class-editor'), feedback = container.querySelector('.profile-feedback');
  const reload = () => mountProfile(container, { api, esc, loading, isCurrent, sandbox, config });
  const disableControls = () => {
    const controls = [...container.querySelectorAll('button,input')].map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    return () => controls.forEach(([control, disabled]) => { control.disabled = disabled; });
  };
  for (const course of classes) {
    const card = document.createElement('article');
    const approved = hasHours(course.approvedCredits), requested = hasHours(course.credits);
    const needsHours = !requested;
    const status = course.removalPending ? 'Removal awaiting review' : needsHours ? 'Credit hours needed' : course.status === 'approved' ? 'Class approved' : course.status === 'denied' ? 'Class denied' : course.status === 'pending' ? 'Awaiting class review' : 'Syllabus needed';
    const statusClass = course.removalPending || needsHours ? 'pending' : course.status === 'approved' ? 'approved' : course.status === 'denied' ? 'denied' : 'pending';
    const hours = `${approved ? `${esc(formatHours(course.approvedCredits))} approved credit hours` : 'No credit hours approved yet'}${requested && course.status !== 'approved' ? ` · ${esc(formatHours(course.credits))} ${course.status === 'denied' ? 'submitted' : 'requested'}` : ''}`;
    card.className = 'profile-class-card';
    card.innerHTML = `<div class="class-card-heading"><h3>${esc(course.name)}</h3><span class="status ${statusClass}">${status}</span></div><p class="class-credit-hours">${hours}</p>${course.removalPending ? '<p class="muted">These hours remain in your total until the Chair approves removal.</p>' : course.removalReview?.decision === 'denied' ? `<p class="review-note"><strong>Removal denied.</strong> ${esc(course.removalReview.note || '')}</p>` : ''}${course.reviewNote ? `<p class="review-note">${esc(course.reviewNote)}</p>` : ''}${course.syllabusId ? '<details class="syllabus-reference"><summary>View syllabus</summary><div class="syllabus-preview"></div></details>' : ''}<div class="class-card-actions"><button class="text-btn" type="button" data-replace${course.removalPending ? ' disabled' : ''}>${course.syllabusId ? 'Update class' : 'Add hours and syllabus'}</button><button class="text-btn" type="button" data-remove${course.removalPending ? ' disabled' : ''}>Remove class</button></div><div class="class-remove-confirm" hidden><p>${approved ? 'Ask the Chair to remove this class? Its approved hours stay in your total until the request is approved.' : 'Remove this class from your current list?'} Existing submissions keep their syllabus reference.</p><button class="button ghost" type="button" data-cancel-remove>Cancel</button> <button class="button danger" type="button" data-confirm-remove>${approved ? 'Request removal' : 'Remove class'}</button></div><div class="class-feedback" role="status"></div>`;
    list.append(card);
    card.querySelector('[data-replace]').onclick = () => edit(course, card.querySelector('[data-replace]'));
    const details = card.querySelector('details');
    if (details) details.ontoggle = () => {
      if (details.open && !details.dataset.loaded) {
        details.dataset.loaded = 'true';
        mountSyllabusPreview(details.querySelector('.syllabus-preview'), course.syllabusId, { api, esc, loading, isCurrent });
      }
    };
    {
      const confirm = card.querySelector('.class-remove-confirm');
      card.querySelector('[data-remove]').onclick = () => { confirm.hidden = false; card.querySelector('[data-cancel-remove]').focus(); };
      card.querySelector('[data-cancel-remove]').onclick = () => { confirm.hidden = true; card.querySelector('[data-remove]').focus(); };
      card.querySelector('[data-confirm-remove]').onclick = async () => {
        const restoreControls = disableControls();
        const status = card.querySelector('.class-feedback');
        status.innerHTML = loading(approved ? 'Requesting removal…' : 'Removing class…', true);
        try {
          await api(`/api/classes/${encodeURIComponent(course.id || 'legacy')}/archive`, { method: 'POST', body: { version: course.version, ...(course.id ? {} : { name: course.name }) } });
          if (isCurrent()) {
            await reload();
            if (isCurrent()) {
              container.querySelector('.profile-feedback').textContent = approved ? 'Removal requested. Your approved hours stay in place until Chair approval.' : 'Class removed.';
              container.querySelector('#add-class').focus();
            }
          }
        } catch (error) { if (isCurrent()) status.textContent = error.message; }
        finally { restoreControls(); }
      };
    }
  }
  if (!classes.length) list.innerHTML = '<p class="muted">No classes added yet.</p>';
  function edit(course = null, opener = container.querySelector('#add-class')) {
    if (course?.removalPending) return;
    feedback.textContent = '';
    editor.hidden = false;
    const initialHours = hasHours(course?.credits) ? course.credits : hasHours(course?.approvedCredits) ? course.approvedCredits : '';
    editor.innerHTML = `<h3>${course ? 'Update class' : 'Add class'}</h3>${course?.syllabusId ? '<p class="muted">Upload the syllabus for a new review. Previously approved hours stay in your total until the Chair approves the change.</p>' : ''}<form id="profile-form"><div class="field"><label for="class-name">Class name or code</label><input id="class-name" name="name" required maxlength="80" placeholder="e.g. MTH 2002 · Calculus II" value="${esc(course?.name || '')}"${course ? ' readonly' : ''}></div><div class="field"><label for="class-credits">Credit hours</label><input id="class-credits" name="credits" type="number" inputmode="decimal" min="0" max="30" step="0.01" required placeholder="e.g. 3" value="${esc(String(initialHours))}" aria-describedby="class-credits-help"><small id="class-credits-help">Use the credit hours listed for this class. The Chair will verify them with your syllabus.</small></div><div class="field"><label for="class-syllabus">Syllabus</label><input id="class-syllabus" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" required aria-describedby="class-syllabus-help"><small id="class-syllabus-help">PDF, PNG, or JPEG, up to ${sandbox ? 1 : 5} MB.${sandbox ? ' Use a fictional syllabus in the sandbox.' : ''}</small></div><div class="profile-feedback" role="status"></div><div class="modal-actions"><button class="button ghost" type="button" data-cancel>Cancel</button><button class="button gold" type="submit">Submit class for review</button></div></form>`;
    const form = editor.querySelector('form'), status = form.querySelector('.profile-feedback');
    form.querySelector('[data-cancel]').onclick = () => { editor.hidden = true; editor.replaceChildren(); opener.focus(); };
    form.onsubmit = async event => {
      event.preventDefault();
      const creditsInput = form.querySelector('#class-credits'), credits = creditsInput.valueAsNumber;
      if (!Number.isFinite(credits) || credits < 0 || credits > 30 || Math.abs(credits * 100 - Math.round(credits * 100)) > 0.000001) { status.textContent = 'Enter credit hours from 0 to 30, with up to two decimal places.'; creditsInput.focus(); return; }
      let file = form.querySelector('#class-syllabus').files[0];
      const mime = file?.type || (/\.pdf$/i.test(file?.name || '') ? 'application/pdf' : /\.png$/i.test(file?.name || '') ? 'image/png' : /\.jpe?g$/i.test(file?.name || '') ? 'image/jpeg' : '');
      if (!file || !['application/pdf', 'image/png', 'image/jpeg'].includes(mime) || file.size > (sandbox ? 1 : 5) * 1024 * 1024) { status.textContent = `Choose a PDF, PNG, or JPEG up to ${sandbox ? 1 : 5} MB.`; return; }
      if (!file.type) file = new File([file], file.name, { type: mime });
      const name = form.querySelector('#class-name').value.trim();
      const restoreControls = disableControls();
      status.innerHTML = loading('Uploading syllabus…', true);
      try {
        const evidence = sandbox ? { file: { name: file.name, mime, size: file.size, dataUrl: await readImage(file) } } : { evidenceId: await uploadImage(file, api, config) };
        if (!isCurrent()) return;
        status.innerHTML = loading('Submitting class…', true);
        await api('/api/classes', { method: 'POST', body: { name, credits, ...evidence, ...(course?.id ? { classId: course.id, version: course.version } : {}) } });
        if (isCurrent()) {
          await reload();
          if (isCurrent()) { container.querySelector('.profile-feedback').textContent = 'Class submitted. Credit hours apply and assignments unlock after Chair approval.'; container.querySelector('#add-class').focus(); }
        }
      } catch (error) { if (isCurrent()) status.textContent = error.message; }
      finally { restoreControls(); }
    };
    form.querySelector(course ? '#class-credits' : '#class-name').focus();
  }
  container.querySelector('#add-class').onclick = () => edit();
}

export function mountCoursePicker(input, classes, esc) {
  const select = document.createElement('select');
  select.id = 'saved-course';
  input.before(select);
  const customLabel = document.createElement('label');
  customLabel.htmlFor = input.id; customLabel.textContent = 'Course or subject';
  input.before(customLabel);
  const hint = document.createElement('small');
  hint.className = 'syllabus-course-hint';
  input.after(hint);
  const field = input.closest('.field'), label = field.querySelector('label');
  const form = input.closest('form'), submit = form.querySelector('button[type="submit"]');
  let currentActivity = null, previousMode = null;
  const sync = () => {
    const graded = Boolean(currentActivity?.grade), noCourse = ['meeting', 'calendar'].includes(currentActivity?.id);
    customLabel.hidden = graded || select.value !== '__other__';
    if (graded) {
      input.value = classes.find(course => course.id === select.value)?.name || '';
      input.hidden = true; input.disabled = false; input.required = false;
    } else {
      const other = select.value === '__other__';
      input.hidden = !other; input.disabled = !other || noCourse;
      input.required = other && !noCourse && currentActivity?.id !== 'night';
    }
    label.htmlFor = select.hidden ? input.id : select.id;
  };
  const update = activity => {
    currentActivity = activity;
    const graded = Boolean(activity?.grade), mode = graded ? 'graded' : 'other';
    const approved = classes.filter(course => course.id && course.status === 'approved');
    if (mode !== previousMode) {
      const previousName = select.selectedOptions[0]?.textContent || input.value;
      select.innerHTML = graded
        ? `<option value="">${approved.length ? 'Choose an approved class' : 'No approved classes yet'}</option>${approved.map(course => `<option value="${esc(course.id)}">${esc(course.name)}</option>`).join('')}`
        : `<option value="">Choose a class</option>${classes.map(course => `<option value="${esc(course.name)}">${esc(course.name)}</option>`).join('')}<option value="__other__">Other / not a class</option>`;
      const matching = [...select.options].find(option => option.textContent === previousName && option.value);
      if (matching) select.value = matching.value;
      previousMode = mode;
    }
    const noCourse = ['meeting', 'calendar'].includes(activity?.id);
    select.name = graded ? 'classId' : select.value === '__other__' ? '' : 'course';
    select.hidden = noCourse;
    select.disabled = noCourse || (graded && !approved.length);
    select.required = !noCourse && activity?.id !== 'night';
    submit.disabled = graded && !approved.length;
    hint.hidden = !graded;
    hint.innerHTML = approved.length ? 'Only classes with an approved syllabus are available.' : 'Add a class and upload its syllabus in <a href="#profile">My profile</a>. Assignments unlock after Chair approval.';
    const link = hint.querySelector('a');
    if (link) link.onclick = () => input.closest('dialog')?.close();
    sync();
  };
  select.onchange = () => { select.name = currentActivity?.grade ? 'classId' : select.value === '__other__' ? '' : 'course'; sync(); };
  input.coursePicker = { update };
  return input.coursePicker;
}
