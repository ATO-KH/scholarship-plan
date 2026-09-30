const esc = (value) => String(value ?? "").replace(/[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export async function mountFaq({ container, user, api, isCurrent, demo = false }) {
  const current = () => container.isConnected && isCurrent();
  const chair = user.role === "chair";
  let view;
  try {
    view = await api("/api/faq");
    if (current()) render();
  } catch (error) {
    if (current()) container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p>`;
  }
  function render() {
    container.innerHTML = `<div class="faq-toolbar"><span class="status pending">Work in progress</span>${chair ? '<button class="button gold small" id="faq-add" type="button">Add question</button>' : ""}</div><div class="faq-list">${view.entries.map((entry) => `<details class="faq-item" data-faq-id="${esc(entry.id)}"><summary>${esc(entry.question)}</summary><div class="faq-answer"><p>${esc(entry.answer)}</p>${chair ? `<div class="faq-item-actions"><button class="table-link" type="button" data-faq-edit="${esc(entry.id)}">Edit</button><button class="table-link" type="button" data-faq-delete="${esc(entry.id)}">Remove</button></div>` : ""}</div></details>`).join("") || '<p class="muted">No questions have been added yet.</p>'}</div>${demo ? '<p class="footnote">FAQ changes in this sandbox stay in its fictional demo records.</p>' : ""}`;
    if (!chair) return;
    container.querySelector("#faq-add").onclick = () => editor();
    container.querySelectorAll("[data-faq-edit]").forEach((button) => {
      button.onclick = () => editor(view.entries.find((entry) => entry.id === button.dataset.faqEdit));
    });
    container.querySelectorAll("[data-faq-delete]").forEach((button) => {
      button.onclick = () => editor(view.entries.find((entry) => entry.id === button.dataset.faqDelete), true);
    });
  }
  function editor(entry, removing = false) {
    if (!current()) return;
    const dialog = document.createElement("dialog");
    dialog.className = "faq-editor";
    dialog.setAttribute("aria-labelledby", "faq-editor-title");
    dialog.innerHTML = `<div class="modal-heading"><h2 id="faq-editor-title">${removing ? "REMOVE QUESTION?" : entry ? "EDIT QUESTION" : "ADD QUESTION"}</h2><button class="close faq-cancel" type="button" aria-label="Close FAQ editor">×</button></div><form>${removing ? `<p>${esc(entry.question)}</p>` : `<div class="field"><label for="faq-question">Question</label><input id="faq-question" name="question" maxlength="200" required value="${esc(entry?.question || "")}"></div><div class="field"><label for="faq-answer">Answer</label><textarea id="faq-answer" name="answer" maxlength="4000" rows="7" required>${esc(entry?.answer || "")}</textarea></div>`}<p class="faq-editor-error error" role="alert"></p><div class="modal-actions"><button class="button ghost faq-cancel" type="button">Cancel</button><button class="button ${removing ? "danger" : "gold"}" type="submit">${removing ? "Remove question" : "Save for all members"}</button></div></form>`;
    container.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.querySelectorAll(".faq-cancel").forEach((button) => { button.onclick = () => dialog.close(); });
    dialog.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      if (!current()) return dialog.close();
      const submit = dialog.querySelector('[type="submit"]');
      const body = removing ? { operation: "delete", version: view.version, id: entry.id } :
        { operation: "upsert", version: view.version, entry: { id: entry?.id || null,
          question: dialog.querySelector("#faq-question").value, answer: dialog.querySelector("#faq-answer").value } };
      submit.disabled = true;
      try {
        const updated = await api("/api/faq", { method: "POST", body });
        if (!current()) return;
        view = updated;
        dialog.close();
        render();
        const added = !removing && view.entries.find((item) => item.id === entry?.id || item.question === body.entry.question.trim());
        if (added) {
          const details = [...container.querySelectorAll("details")].find((item) => item.dataset.faqId === added.id);
          details.open = true;
          details.querySelector("summary").focus();
        } else container.querySelector("#faq-add").focus();
      } catch (error) {
        if (current()) dialog.querySelector(".faq-editor-error").textContent = error.message;
      } finally { if (dialog.isConnected) submit.disabled = false; }
    };
    dialog.showModal();
  }
}
