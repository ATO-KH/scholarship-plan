export async function mountBadgeSettings(container, { api, esc, loading, isCurrent, demo = false }) {
  const current = () => container.isConnected && isCurrent();
  if (demo) {
    container.innerHTML = '<h2>CHAPTER BADGE</h2><p class="muted">Badge sign-in changes are unavailable for demo and test accounts.</p>';
    return;
  }
  const load = async () => {
    if (!current()) return;
    container.innerHTML = `<h2>CHAPTER BADGE</h2>${loading("Loading badge details…", true)}`;
    try {
      let details = await api("/api/account/badge");
      if (!current()) return;
      container.innerHTML = `<h2>CHAPTER BADGE</h2><p class="muted">Your email and permanent portal ID still work for sign-in.</p><p>Portal ID: <code>${esc(details.loginId || "—")}</code></p><form class="badge-form"><div class="field"><label for="profile-badge">Badge number (optional)</label><input id="profile-badge" name="badge" type="text" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="profile-badge-help" value="${esc(details.badge)}"><small id="profile-badge-help">Use your chapter badge number, not your university 900 number. Leave blank to remove it.</small></div><div class="badge-feedback" role="status" aria-live="polite"></div><button class="button gold" type="submit">Save badge number</button><button class="text-btn" type="button" data-reload-badge hidden>Reload badge details</button></form>`;
      const form = container.querySelector("form"), input = form.querySelector("input");
      const feedback = form.querySelector(".badge-feedback"), reload = form.querySelector("[data-reload-badge]");
      const controls = [...form.querySelectorAll("input,button")];
      let pending = false;
      reload.onclick = load;
      form.onsubmit = async event => {
        event.preventDefault();
        if (pending || !current()) return;
        pending = true;
        controls.forEach(control => control.disabled = true);
        feedback.classList.remove("error");
        feedback.innerHTML = loading("Saving badge number…", true);
        reload.hidden = true;
        try {
          const saved = await api("/api/account/badge", { method: "POST", body: { badge: input.value, version: details.version } });
          if (!current() || !form.isConnected) return;
          details = saved;
          input.value = saved.badge;
          feedback.textContent = saved.badge ? "Badge number saved. You can use it to sign in." : "Badge number removed. Your email and portal ID still work.";
        } catch (error) {
          if (!current() || !form.isConnected) return;
          feedback.classList.add("error");
          feedback.textContent = error.message;
          reload.hidden = false;
        } finally {
          pending = false;
          if (current() && form.isConnected) controls.forEach(control => control.disabled = false);
        }
      };
    } catch (error) {
      if (!current()) return;
      container.innerHTML = `<h2>CHAPTER BADGE</h2><p class="error" role="alert">${esc(error.message)}</p><button class="button ghost" type="button">Try again</button>`;
      container.querySelector("button").onclick = load;
    }
  };
  await load();
}
