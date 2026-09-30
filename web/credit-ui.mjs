export async function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}
export async function uploadImage(file, api, config) {
  if (config.uploadMode === "direct") {
    const { uploadUrl, id } = await api("/api/uploads/init", { method: "POST", body: { name: file.name, mime: file.type, size: file.size } });
    const url = new URL(uploadUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw Error("Upload destination unavailable.");
    const response = await fetch(url.href, { method: "PUT", credentials: "omit", redirect: "error", headers: { "Content-Type": file.type, "x-upsert": "false" }, body: file, signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw Error("Image upload failed. Please try again.");
    const result = await api(`/api/uploads/${encodeURIComponent(id)}/complete`, { method: "POST", body: {} });
    return result.upload.id;
  }
  const data = await readImage(file);
  const result = await api("/api/uploads", { method: "POST", body: { name: file.name, mime: file.type, base64: data.split(",")[1] } });
  return result.upload.id;
}
export async function mountCreditRequests(container, { api, esc, loading, isCurrent, chair = false, sandbox = false, config = {}, onChange = () => {} }) {
  const view = await api("/api/credit-requests");
  if (!isCurrent()) return;
  const pending = view.requests.some(item => item.status === "pending");
  container.innerHTML = chair ? '<h2>Credit-hours requests</h2>' : `<h2>Submit credit hours</h2><p>Approved credit hours: <strong>${esc(view.credits)}</strong></p><p class="muted">Upload an image showing your enrolled credit hours. Changes take effect after Chair approval.</p>${pending ? '<p class="notice">Your request is awaiting review.</p>' : `<form id="credit-form"><div class="field"><label for="credit-hours">Credit hours</label><input id="credit-hours" name="credits" type="number" min="0" max="30" step="any" required placeholder="e.g. 15"></div><div class="field"><label for="credit-image">Enrollment image</label><input id="credit-image" type="file" accept="image/png,image/jpeg" required><small>PNG or JPEG, up to ${sandbox ? "1" : "5"} MB.${sandbox ? " Use a fictional image in the sandbox." : ""}</small></div><div class="credit-feedback" role="status"></div><button class="button gold" type="submit">Submit for approval</button></form>`}`;
  const list = document.createElement("div");
  list.className = "credit-request-list";
  container.append(list);
  list.innerHTML = view.requests.length ? view.requests.map(item => `<article class="credit-request"><h3>${chair ? esc(item.memberName) + " · " : ""}${esc(item.credits)} credit hours</h3><p><span class="status ${esc(item.status)}">${item.status === "pending" ? "Pending review" : item.status === "approved" ? "Approved" : "Denied"}</span> <small>${esc(new Date(item.createdAt).toLocaleDateString())}</small></p>${chair ? `<p>Previously approved: ${esc(item.previousCredits)} hours</p>` : ""}${item.reviewNote ? `<p>${esc(item.reviewNote)}</p>` : ""}<button type="button" class="text-btn" data-image="${esc(item.id)}">View image</button><div class="credit-evidence"></div>${chair && item.status === "pending" ? `<form data-review="${esc(item.id)}"><div class="field"><label for="credit-note-${esc(item.id)}">Review note (required to deny)</label><textarea id="credit-note-${esc(item.id)}" name="note" maxlength="1000"></textarea></div><div class="credit-feedback" role="status"></div><div class="credit-review-actions"><button class="button gold" type="submit" value="approved">Approve</button><button class="button ghost" type="submit" value="denied">Deny</button></div></form>` : ""}</article>`).join("") : chair ? '<p class="muted">No credit-hours requests.</p>' : "";
  const reload = () => mountCreditRequests(container, { api, esc, loading, isCurrent, chair, sandbox, config, onChange });
  container.querySelectorAll("[data-image]").forEach(button => {
    button.onclick = async () => {
      const destination = button.nextElementSibling;
      destination.innerHTML = loading("Loading image…", true);
      button.disabled = true;
      try {
        const result = await api(`/api/credit-requests/${encodeURIComponent(button.dataset.image)}/evidence`);
        if (!isCurrent() || !destination.isConnected) return;
        const image = document.createElement("img");
        image.alt = "Submitted enrollment evidence";
        image.className = "credit-evidence-image";
        image.onload = () => destination.replaceChildren(image);
        image.onerror = () => { destination.textContent = "Image unavailable. Try again."; };
        image.src = result.image;
      } catch (error) { if (destination.isConnected) destination.textContent = error.message; }
      finally { button.disabled = false; }
    };
  });
  const form = container.querySelector("#credit-form");
  if (form) form.onsubmit = async event => {
    event.preventDefault();
    const file = form.querySelector("#credit-image").files[0];
    const feedback = form.querySelector(".credit-feedback");
    if (!file || !["image/png", "image/jpeg"].includes(file.type) || file.size > (sandbox ? 1 : 5) * 1024 * 1024) { feedback.textContent = `Choose a PNG or JPEG image up to ${sandbox ? 1 : 5} MB.`; return; }
    const credits = Number(form.querySelector("#credit-hours").value);
    const controls = [...form.querySelectorAll("input,button")];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading("Submitting credit hours…", true);
    try {
      const evidence = sandbox ? { image: await readImage(file) } : { evidenceId: await uploadImage(file, api, config) };
      if (!isCurrent()) return;
      await api("/api/credit-requests", { method: "POST", body: { credits, ...evidence } });
      if (isCurrent()) await reload();
    } catch (error) { if (form.isConnected) feedback.textContent = error.message; }
    finally { controls.forEach(control => control.disabled = false); }
  };
  container.querySelectorAll("[data-review]").forEach(form => {
    form.onsubmit = async event => {
      event.preventDefault();
      const feedback = form.querySelector(".credit-feedback");
      const decision = event.submitter?.value;
      const note = form.querySelector("textarea").value;
      const controls = [...form.querySelectorAll("textarea,button")];
      controls.forEach(control => control.disabled = true);
      feedback.innerHTML = loading("Saving review…", true);
      try {
        await api(`/api/credit-requests/${encodeURIComponent(form.dataset.review)}/review`, { method: "POST", body: { decision, note } });
        if (isCurrent()) { await reload(); onChange(); }
      } catch (error) { if (form.isConnected) feedback.textContent = error.message; }
      finally { controls.forEach(control => control.disabled = false); }
    };
  });
}
