import { creditMultiplier } from './credit-load-data.mjs';

export async function mountCreditLoad(container, { owner, view, api, esc, loading, isCurrent = () => container.isConnected, onSaved = () => {}, onBusy = () => {}, draft }) {
  const path = `/api/roster/${encodeURIComponent(owner)}/credit-load`;
  const current = () => container.isConnected && isCurrent();
  if (!view) {
    container.innerHTML = loading('Loading semester credit load…', true);
    try { view = (await api(path)).creditLoad; }
    catch (error) {
      if (current()) {
        container.innerHTML = `<p class="error">${esc(error.message)}</p><button class="button ghost" type="button">Retry credit load</button>`;
        container.querySelector('button').onclick = () => mountCreditLoad(container, { owner, api, esc, loading, isCurrent, onSaved, onBusy });
      }
      return;
    }
  }
  if (!current()) return;
  container.innerHTML = `<details class="credit-load-panel" ${view.confirmed && !draft ? '' : 'open'}><summary><strong>Semester credit load</strong> · ${view.confirmed ? `${esc(view.credits)} hours · ${esc(view.multiplier)}×` : 'Needs confirmation · 1×'}</summary><p>${view.needsReview ? 'Approved class hours now exceed the confirmed load. The multiplier is 1× until the full schedule is confirmed again.' : 'Class approvals unlock assignments. The full semester load below controls the point multiplier.'}</p><p class="footnote">${esc(view.approvedCredits)} hours approved across submitted classes. Include the member’s entire enrolled schedule, even classes not uploaded yet.</p><form class="credit-load-form" data-version="${esc(view.version)}"><div class="field"><label>Full semester credit hours<input type="number" name="credits" min="0" max="30" step="0.01" inputmode="decimal" required placeholder="e.g. 15" value="${esc(draft?.version === view.version ? draft.credits : view.credits ?? '')}"></label><small data-load-preview aria-live="polite"></small></div><label class="checkbox-line"><input type="checkbox" name="confirm" required><span>I checked this member’s full semester schedule.</span></label><p class="footnote">Changes update pending estimates. Previously awarded points stay recorded.</p><p data-load-feedback role="status"></p><button class="button gold" type="submit">${view.confirmed ? 'Update confirmed credit load' : 'Confirm full credit load'}</button></form></details>`;
  const form = container.querySelector('form'), input = form.elements.credits, feedback = form.querySelector('[data-load-feedback]');
  const preview = () => {
    const credits = input.valueAsNumber;
    form.querySelector('[data-load-preview]').textContent = input.value !== '' && input.checkValidity()
      ? `${creditMultiplier(credits)}× multiplier after confirmation.` : `Current multiplier: ${view.multiplier}×.`;
  };
  input.oninput = preview; preview();
  let saving = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving || !current() || !form.reportValidity()) return;
    saving = true; onBusy(true);
    const controls = [...form.querySelectorAll('input,button')];
    const body = { credits: input.valueAsNumber, version: view.version };
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading('Saving semester credit load…', true);
    let saved = false;
    try {
      const result = await api(path, { method: 'POST', body });
      saved = true;
      if (!current()) return;
      await onSaved(result);
      if (current()) {
        await mountCreditLoad(container, { owner, view: result.creditLoad, api, esc, loading, isCurrent, onSaved, onBusy });
        container.querySelector('[data-load-feedback]').textContent = 'Full credit load confirmed. Pending estimates updated.';
      }
    } catch (error) {
      if (current()) {
        feedback.textContent = saved ? 'Credit load saved. Refresh to see the updated points.' : error.message;
        if (error.status === 409) {
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button ghost'; retry.textContent = 'Reload current credit load';
          retry.onclick = () => mountCreditLoad(container, { owner, api, esc, loading, isCurrent, onSaved, onBusy });
          feedback.append(retry);
          saved = true;
        }
      }
    } finally {
      saving = false; onBusy(false);
      if (!saved) controls.forEach(control => control.disabled = false);
    }
  };
}
