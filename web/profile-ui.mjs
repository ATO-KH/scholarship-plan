export async function mountProfile(container, { api, esc, loading, name, isCurrent }) {
  let profile = await api("/api/profile");
  if (!isCurrent()) return;
  container.innerHTML = `<h2>${esc(name)}</h2><h3>My classes</h3><p class="muted">Add the classes you’re taking this semester. These appear when you make a submission.</p><form id="profile-form"><div class="profile-courses"></div><button class="button ghost" type="button" id="add-class">Add class</button><div class="profile-feedback" role="status"></div><div class="modal-actions"><button class="button gold" type="submit">Save classes</button></div></form>`;
  const form = container.querySelector("form"), rows = form.querySelector(".profile-courses"), feedback = form.querySelector(".profile-feedback");
  let sequence = 0;
  const add = (value = "", focus = false) => {
    if (rows.children.length >= 20) { feedback.textContent = "You can save up to 20 classes."; return; }
    const id = `profile-course-${++sequence}`;
    const row = document.createElement("div");
    row.className = "profile-course-row";
    row.innerHTML = `<div class="field"><label for="${id}">Class name or code</label><input id="${id}" name="course" required maxlength="80" placeholder="e.g. MTH 2002 · Calculus II" value="${esc(value)}"></div><button class="button ghost" type="button" aria-label="Remove class">Remove</button>`;
    row.querySelector("button").onclick = () => { row.remove(); form.querySelector("#add-class").focus(); };
    rows.append(row);
    if (focus) row.querySelector("input").focus();
  };
  profile.courses.forEach(value => add(value));
  form.querySelector("#add-class").onclick = () => add("", true);
  form.onsubmit = async event => {
    event.preventDefault();
    const courses = [...rows.querySelectorAll("input")].map(input => input.value);
    const controls = [...form.querySelectorAll("input,button")];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading("Saving classes…", true);
    try {
      profile = await api("/api/profile", { method: "POST", body: { courses, version: profile.version } });
      if (isCurrent()) feedback.textContent = "Classes saved.";
    } catch (error) {
      if (isCurrent()) feedback.textContent = error.message;
    } finally {
      controls.forEach(control => control.disabled = false);
    }
  };
}

export function mountCoursePicker(input, courses, esc) {
  if (!courses.length || input.value) return;
  const select = document.createElement("select");
  select.id = "saved-course";
  select.name = "course";
  select.required = true;
  select.innerHTML = `<option value="">Choose a class</option>${courses.map((course, index) => `<option value="${esc(course)}" data-index="${index}">${esc(course)}</option>`).join("")}<option value="__other__">Other / not a class</option>`;
  input.before(select);
  input.closest(".field").querySelector("label").htmlFor = select.id;
  const customLabel = document.createElement("label");
  customLabel.htmlFor = input.id;
  customLabel.textContent = "Course or activity group";
  input.before(customLabel);
  const sync = () => {
    const other = select.selectedIndex === select.options.length - 1;
    input.hidden = customLabel.hidden = !other;
    input.disabled = !other;
    select.name = other ? "" : "course";
    if (other) input.focus();
  };
  select.onchange = sync;
  sync();
}
