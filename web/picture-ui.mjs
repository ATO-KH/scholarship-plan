import { readImage, uploadImage } from "./credit-ui.mjs";
export async function mountPicture(container, { api, esc, loading, isCurrent, name, sandbox = false, config = {} }) {
  const picture = await api("/api/profile/picture");
  if (!isCurrent()) return;
  container.innerHTML = `<h2>Profile picture</h2><div class="profile-picture-preview">${picture.image ? `<img src="${esc(picture.image)}" alt="Your profile picture">` : `<span aria-label="No profile picture">${esc(name.split(/\s+/).map(part => part[0]).slice(0,2).join(""))}</span>`}</div><form class="picture-form"><div class="field"><label for="profile-picture">Choose a picture</label><input id="profile-picture" type="file" accept="image/png,image/jpeg" required><small>PNG or JPEG, up to ${sandbox ? 1 : 5} MB.</small></div><div class="picture-feedback" role="status"></div><div class="picture-actions"><button class="button gold" type="submit">Save picture</button>${picture.image ? '<button class="button ghost" type="button" data-remove-picture>Remove</button>' : ""}</div></form>`;
  const form = container.querySelector("form"), feedback = form.querySelector(".picture-feedback");
  async function save(remove) {
    const file = form.querySelector("input").files[0];
    if (!remove && (!file || !["image/png", "image/jpeg"].includes(file.type) || file.size > (sandbox ? 1 : 5) * 1024 * 1024)) { feedback.textContent = "Choose a PNG or JPEG within the size limit."; return; }
    const controls = [...form.querySelectorAll("button,input")];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading(remove ? "Removing picture…" : "Saving picture…", true);
    try {
      const body = sandbox ? { image: remove ? null : await readImage(file) } : { evidenceId: remove ? null : await uploadImage(file, api, config) };
      if (!isCurrent()) return;
      await api("/api/profile/picture", { method: "POST", body });
      if (isCurrent()) await mountPicture(container, { api, esc, loading, isCurrent, name, sandbox, config });
    } catch (error) { if (form.isConnected) feedback.textContent = error.message; }
    finally { controls.forEach(control => control.disabled = false); }
  }
  form.onsubmit = event => { event.preventDefault(); save(false); };
  const remove = form.querySelector("[data-remove-picture]");
  if (remove) remove.onclick = () => save(true);
}
