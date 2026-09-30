export async function mountPointAdjustments(container, { api, esc, loading, memberId, canEdit, isCurrent, onSaved }) {
  const path = `/api/members/${encodeURIComponent(memberId)}/point-adjustments`;
  let view, saving = false;
  const signed = value => `${value >= 0 ? "+" : ""}${value}`;
  container.innerHTML = loading("Loading point history…");
  try {
    view = await api(path);
    if (isCurrent()) render();
  } catch (error) { if (isCurrent()) container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`; }
  function render(message = "") {
    container.innerHTML = `<h3>${esc(view.member.name)}</h3><dl class="details"><div><dt>Approved submissions</dt><dd>${view.submissionPoints}</dd></div><div><dt>Manual adjustments</dt><dd>${signed(view.adjustmentPoints)}</dd></div><div><dt>Current approved total</dt><dd><strong>${view.approved}</strong></dd></div></dl>${canEdit ? `<form id="point-adjustment-form"><p>Enter the approved total this member should have now, including points earned before using the portal. Approved submissions stay unchanged. Future approvals add to this total.</p><div class="field"><label for="point-total">New approved total</label><input id="point-total" type="number" name="total" min="0" max="10000" step="1" value="${view.approved}" required><small id="point-change" aria-live="polite"></small></div><div class="field"><label for="point-reason">Reason (visible to the member)</label><textarea id="point-reason" name="reason" maxlength="1000" required placeholder="e.g. 20 points earned before portal rollout"></textarea></div><p class="footnote">Enter final points; no credit-load multiplier is applied. Adjustments are cleared when the Chair starts a new semester.</p><div id="point-feedback" role="status">${esc(message)}</div><div class="modal-actions"><button class="button gold" type="submit">Save point adjustment</button></div></form>` : ""}<h3>ADJUSTMENT HISTORY</h3>${view.history.length ? `<div class="history">${view.history.map(entry => `<article><p><strong>${signed(entry.delta)} points · ${entry.previousTotal} → ${entry.total}</strong><small>${esc(new Date(entry.at).toLocaleString())} · ${esc(entry.actor)}</small></p><p>${esc(entry.reason)}</p></article>`).join("")}</div>` : '<p class="muted">No manual adjustments this semester.</p>'}`;
    if (!canEdit) return;
    const form = container.querySelector("form"), total = form.elements.total;
    const preview = () => {
      const value = Number(total.value);
      container.querySelector("#point-change").textContent = total.value !== "" && Number.isInteger(value) && value >= 0 && value <= 10000
        ? `${view.approved} → ${value} approved points (${signed(value - view.approved)} adjustment).` : "Enter a whole-point total.";
    };
    total.oninput = preview;
    preview();
    form.onsubmit = async event => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      const body = { version: view.version, total: Number(total.value), reason: form.elements.reason.value };
      const controls = [...form.querySelectorAll("input,textarea,button")];
      controls.forEach(control => control.disabled = true);
      const feedback = container.querySelector("#point-feedback");
      feedback.innerHTML = loading("Saving point adjustment…", true);
      let saved = false;
      try {
        view = await api(path, { method: "POST", body });
        saved = true;
        if (!isCurrent()) return;
        await onSaved();
        if (isCurrent()) render("Point adjustment saved.");
      } catch (error) {
        if (isCurrent()) feedback.innerHTML = `<p class="error">${esc(saved ? "Adjustment saved. Close this window and reload to see the latest totals." : error.message)}</p>`;
      } finally { saving = false; controls.forEach(control => control.disabled = false); }
    };
  }
}
