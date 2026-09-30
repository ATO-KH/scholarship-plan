import { validateCheckpointQuotas } from "./checkpoint-data.mjs";

export async function mountCheckpointEditor(container, { api, esc, loading, isCurrent, onSaved }) {
  container.innerHTML = loading("Loading checkpoint quotas…");
  try {
    const view = await api("/api/checkpoint-quotas");
    if (!isCurrent()) return;
    const dateLabel = value => new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    container.innerHTML = `<form id="checkpoint-quota-form"><p>Set cumulative approved points for each tier. The last column is the semester goal.</p><div class="table-wrap"><table class="checkpoint-quota-table"><thead><tr><th scope="col">Tier</th>${view.checkpoints.map((checkpoint, index) => `<th scope="col">${index === 3 ? "Final goal" : `Checkpoint ${index + 1}`}<small>${esc(dateLabel(checkpoint.date))}</small></th>`).join("")}</tr></thead><tbody>${[0,1,2,3,4].map(tier => `<tr><th scope="row">Tier ${tier + 1}${tier === 0 ? " / PNM" : ""}</th>${view.checkpoints.map((checkpoint, index) => `<td><input type="number" min="${index === 3 ? 1 : 0}" max="10000" step="1" required name="quota-${index}-${tier}" aria-label="Tier ${tier + 1}, ${index === 3 ? "final goal" : `checkpoint ${index + 1}`}" value="${checkpoint.targets[tier]}"></td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="footnote">Use whole points. Requirements must stay the same or increase across checkpoints and tiers. Existing awards do not change.</p><div class="checkpoint-quota-feedback" role="status"></div><div class="modal-actions"><button class="button ghost" type="button" data-action="close">Cancel</button><button class="button gold" type="submit">Save quotas</button></div></form>`;
    const form = container.querySelector("form"), feedback = container.querySelector(".checkpoint-quota-feedback");
    form.onsubmit = async event => {
      event.preventDefault();
      let targets;
      try {
        targets = validateCheckpointQuotas(view.checkpoints.map((_, index) => [0,1,2,3,4].map(tier => Number(form.elements.namedItem(`quota-${index}-${tier}`).value))));
      } catch (error) { feedback.textContent = error.message; return; }
      const controls = [...form.querySelectorAll("input,button")];
      controls.forEach(control => control.disabled = true);
      feedback.innerHTML = loading("Saving quotas…", true);
      let saved = false;
      try {
        const updated = await api("/api/checkpoint-quotas", { method: "POST", body: { targets, version: view.version } });
        saved = true;
        view.version = updated.version;
        if (isCurrent()) await onSaved(updated);
      } catch (error) {
        if (isCurrent()) feedback.textContent = saved ? "Quotas saved. Reload the page to update the display." : error.message;
      } finally {
        controls.forEach(control => control.disabled = false);
      }
    };
  } catch (error) {
    if (isCurrent()) container.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}
