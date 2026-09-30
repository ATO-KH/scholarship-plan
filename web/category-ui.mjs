import { validateCategory } from "./category-data.mjs";

export function categoryHint(category) {
  const details = [];
  if (category.mode === "bands") details.push([...category.bands].sort((a, b) => b.minGrade - a.minGrade).map(band => `${band.minGrade}%+: ${band.points} points`).join(" · "));
  else if (category.mode === "grade") details.push(`Minimum grade: ${category.minGrade}%.`);
  if (category.weeklyLimit !== null && category.weeklyLimit !== undefined) details.push(`Weekly limit: ${category.weeklyLimit} claims.`);
  if (category.study) details.push("Counts toward the shared five-hour weekly study limit.");
  return details.join(" ");
}

export async function mountCategoryManager(container, { api, esc, loading, isCurrent, onSaved }) {
  container.innerHTML = loading("Loading point categories…");
  let view, busy = false;
  const errorMarkup = error => `<p class="error" role="alert">${esc(error.message)}</p>`;
  try {
    view = await api("/api/point-categories");
    if (!isCurrent()) return;
    showList();
  } catch (error) { if (isCurrent()) container.innerHTML = errorMarkup(error); }

  function showList(message = "") {
    if (!isCurrent()) return;
    container.innerHTML = `<p class="footnote">Changes apply to new submissions. Existing submissions keep their original points and evidence requirements.</p><div class="category-toolbar"><button type="button" class="button gold" data-category-action="new">Add category</button></div><div class="category-list">${view.categories.length ? view.categories.map(category => `<article class="category-list-item"><div><h3>${esc(category.name)}</h3><p>${esc(category.points)} points per ${esc(category.mode === "hourly" ? "hour" : category.unit)}</p><small>${esc(categoryHint(category))}</small><span class="category-status">${category.enabled ? "Available to members" : "Disabled for new submissions"}</span></div><div class="category-item-actions"><button type="button" class="button ghost small" data-category-action="edit" data-category-id="${esc(category.id)}" aria-label="Edit ${esc(category.name)}">Edit</button><button type="button" class="button ghost small" data-category-action="toggle" data-category-id="${esc(category.id)}" aria-label="${category.enabled ? "Disable" : "Enable"} ${esc(category.name)}">${category.enabled ? "Disable" : "Enable"}</button></div></article>`).join("") : '<p>No categories yet. Add a category so members can submit activities.</p>'}</div><div class="category-feedback" role="status">${esc(message)}</div><div class="modal-actions"><button type="button" class="button ghost" data-action="close">Done</button></div>`;
    container.querySelectorAll("[data-category-action]").forEach(button => button.onclick = () => {
      if (busy) return;
      const category = view.categories.find(item => item.id === button.dataset.categoryId);
      if (button.dataset.categoryAction === "new") showEditor();
      else if (button.dataset.categoryAction === "edit") showEditor(category);
      else save({ ...category, enabled: !category.enabled }, container.querySelector(".category-feedback"));
    });
  }

  function showEditor(existing = null) {
    const item = existing || { name: "", unit: "activity", proof: "", enabled: true, mode: "fixed", rate: 1, minGrade: 90, bands: [{ minGrade: 90, points: 2 }], study: false, weeklyLimit: null };
    const modes = [["fixed", "Fixed points per activity"], ["hourly", "Points per hour"], ["grade", "Points above a minimum grade"], ["bands", "Points by grade range"]];
    container.innerHTML = `<form class="category-editor"><h3>${existing ? "EDIT CATEGORY" : "ADD CATEGORY"}</h3><div class="form-grid"><div class="field span2"><label for="category-name">Category name</label><input id="category-name" name="name" required maxlength="80" value="${esc(item.name)}" placeholder="e.g. Tutoring session"></div><div class="field"><label for="category-mode">How points are earned</label><select id="category-mode" name="mode">${modes.map(([value, label]) => `<option value="${value}"${item.mode === value ? " selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label for="category-unit">Unit label</label><input id="category-unit" name="unit" required maxlength="40" value="${esc(item.unit)}"><small>For example: assignment or session. Hourly categories always award points per hour.</small></div><div class="field" data-category-field="rate"><label for="category-rate">Points awarded</label><input id="category-rate" name="rate" type="number" min="1" max="50" step="1" value="${item.rate ?? 1}"></div><div class="field" data-category-field="minimum"><label for="category-grade">Minimum grade (%)</label><input id="category-grade" name="minGrade" type="number" min="0" max="100" step="0.01" value="${item.minGrade ?? 90}"></div><div class="field span2" data-category-field="bands"><label>Grade ranges</label><p class="footnote">Enter ranges from lowest to highest minimum grade. Points must stay the same or increase. The highest matching range determines the award. Grades below every range are ineligible.</p><div class="category-bands"></div><button type="button" class="button ghost small" data-category-action="add-band">Add grade range</button></div><div class="field"><label for="category-weekly-limit">Weekly limit <span class="muted">(optional)</span></label><input id="category-weekly-limit" name="weeklyLimit" type="number" min="1" max="100" step="1" value="${item.weeklyLimit ?? ""}"><small data-category-limit-label>Maximum claims in a Monday–Sunday week. Leave blank for no category limit.</small></div><div class="field span2" data-category-field="study"><label class="checkbox-line"><input name="study" type="checkbox"${item.study ? " checked" : ""}><span>Count these hours toward the shared five-hour weekly study limit</span></label></div><div class="field span2"><label for="category-proof">Required evidence</label><textarea id="category-proof" name="proof" required maxlength="1200" rows="3" placeholder="Describe what the member should attach.">${esc(item.proof)}</textarea></div><div class="field span2"><label class="checkbox-line"><input name="enabled" type="checkbox"${item.enabled ? " checked" : ""}><span>Available for new submissions</span></label></div></div><div class="category-feedback" role="status"></div><div class="modal-actions"><button type="button" class="button ghost" data-category-action="cancel">Cancel</button><button type="submit" class="button gold">Save category</button></div></form>`;
    const form = container.querySelector("form"), bands = form.querySelector(".category-bands"), feedback = form.querySelector(".category-feedback");
    let bandId = 0;
    function addBand(band = { minGrade: "", points: "" }) {
      const id = ++bandId, row = document.createElement("div");
      row.className = "category-band";
      row.innerHTML = `<div class="field"><label for="band-grade-${id}">Minimum grade (%)</label><input id="band-grade-${id}" data-band-grade type="number" min="0" max="100" step="0.01" value="${esc(band.minGrade)}" required></div><div class="field"><label for="band-points-${id}">Points</label><input id="band-points-${id}" data-band-points type="number" min="1" max="50" step="1" value="${esc(band.points)}" required></div><button type="button" class="button ghost small" aria-label="Remove grade range">Remove</button>`;
      row.querySelector("button").onclick = () => row.remove();
      bands.append(row);
      return row;
    }
    (item.bands?.length ? item.bands : [{ minGrade: 90, points: 2 }]).forEach(addBand);
    function updateMode() {
      const mode = form.elements.mode.value;
      for (const [field, visible] of Object.entries({ rate: mode !== "bands", minimum: mode === "grade", bands: mode === "bands", study: mode === "hourly" })) {
        const region = form.querySelector(`[data-category-field="${field}"]`);
        region.hidden = !visible;
        region.querySelectorAll("input,button").forEach(input => input.disabled = !visible);
      }
      form.elements.rate.required = mode !== "bands";
      form.elements.minGrade.required = mode === "grade";
      form.querySelector('[for="category-rate"]').textContent = mode === "hourly" ? "Points per hour" : "Points awarded";
      form.querySelector("[data-category-limit-label]").textContent = "Maximum claims in a Monday–Sunday week. Leave blank for no category limit.";
    }
    form.elements.mode.onchange = () => {
      if (form.elements.mode.value === "hourly" && form.elements.unit.value === "activity") form.elements.unit.value = "hour";
      updateMode();
    };
    form.querySelector('[data-category-action="add-band"]').onclick = () => addBand().querySelector("input").focus();
    form.querySelector('[data-category-action="cancel"]').onclick = () => { if (!busy) showList(); };
    form.onsubmit = event => {
      event.preventDefault();
      if (busy) return;
      const data = new FormData(form), mode = data.get("mode");
      let category;
      try {
        category = validateCategory({ ...(existing ? { id: existing.id } : {}), name: data.get("name"), unit: data.get("unit"), proof: data.get("proof"), enabled: data.get("enabled") === "on", mode, rate: Number(data.get("rate") || 1), minGrade: Number(data.get("minGrade") || 0), bands: mode === "bands" ? [...bands.querySelectorAll(".category-band")].map(row => ({ minGrade: Number(row.querySelector("[data-band-grade]").value), points: Number(row.querySelector("[data-band-points]").value) })) : [], study: mode === "hourly" && data.get("study") === "on", weeklyLimit: data.get("weeklyLimit") === "" ? null : Number(data.get("weeklyLimit")) });
      } catch (error) { feedback.textContent = error.message; return; }
      save(category, feedback);
    };
    updateMode();
    form.elements.name.focus();
  }

  async function save(category, feedback) {
    busy = true;
    const controls = [...container.querySelectorAll("input,select,textarea,button")].map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => control.disabled = true);
    feedback.innerHTML = loading("Saving category…", true);
    let saved = false;
    try {
      const updated = await api("/api/point-categories", { method: "POST", body: { version: view.version, category } });
      saved = true;
      if (!isCurrent()) return;
      view = updated;
      await onSaved(updated);
      if (isCurrent()) showList("Category saved.");
    } catch (error) {
      if (isCurrent()) feedback.innerHTML = errorMarkup(saved ? new Error("Category saved. Close this window and reload the page to update the display.") : error);
    } finally {
      busy = false;
      controls.forEach(({ control, disabled }) => control.disabled = disabled);
    }
  }
}
