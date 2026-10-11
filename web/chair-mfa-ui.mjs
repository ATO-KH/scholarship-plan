export async function mountChairMfa(container, { api, esc, initial, onComplete, onCancel, loadingMarkup }) {
  const loading = loadingMarkup || (() => '<p role="status">Loading verification…</p>');
  let state = initial;
  if (!state) {
    container.innerHTML = loading('Loading Chair verification…', true);
    try { state = await api('/api/auth/mfa'); }
    catch (error) {
      if (!container.isConnected) return;
      container.innerHTML = `<p class="error" role="alert">${esc(error.message)}</p><button class="button ghost" type="button">Return to sign in</button>`;
      container.querySelector('button').onclick = onCancel;
      return;
    }
  }
  if (!container.isConnected) return;
  const enroll = state.mfa.stage === 'enroll';
  container.innerHTML = `<h2>${enroll ? 'Set up Chair verification' : 'Verify Chair sign-in'}</h2><p>${enroll ? 'Add this account to an authenticator app, then enter its six-digit code.' : 'Enter the current six-digit code from the Chair account’s authenticator app.'}</p>${enroll ? '<div class="chair-mfa-enrollment"></div>' : ''}<form class="chair-mfa-form"><div class="field"><label for="chair-mfa-code">Authenticator code</label><input id="chair-mfa-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></div><div class="chair-mfa-feedback" role="alert"></div><button class="button gold" type="submit">${enroll ? 'Confirm authenticator' : 'Verify and sign in'}</button></form><button class="text-btn" data-cancel-mfa type="button">Return to sign in</button><details class="chair-mfa-help"><summary>Lost access to the authenticator?</summary><p>Contact the portal operator to verify the office transition or recover access. A password-reset email does not remove this verification step.</p></details>`;
  if (enroll) {
    const box = container.querySelector('.chair-mfa-enrollment');
    const image = document.createElement('img');
    image.alt = 'Scan this QR code with your authenticator app';
    image.width = 224; image.height = 224;
    const qr = state.mfa.qrCode || '';
    // Never inject provider SVG as live markup. An image has no page-script access.
    if (qr.startsWith('<svg')) image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`;
    else if (/^data:image\/svg\+xml[;,]/.test(qr)) image.src = qr;
    if (image.src) box.append(image);
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = 'Enter a setup key instead';
    const key = document.createElement('code'); key.textContent = state.mfa.secret;
    const hint = document.createElement('p'); hint.textContent = 'Choose a time-based account in your authenticator. Keep this setup key private.';
    details.append(summary, hint, key); box.append(details);
  }
  const form = container.querySelector('form'), feedback = container.querySelector('.chair-mfa-feedback');
  let busy = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const code = form.elements.code.value.trim();
    const controls = [...container.querySelectorAll('input,button')];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading('Verifying authenticator…', true);
    try {
      const result = await api('/api/auth/mfa/verify', { method: 'POST', body: { code }, headers: { 'X-CSRF-Token': state.csrfToken } });
      if (!container.isConnected) return;
      container.replaceChildren(); // Remove the enrollment secret before navigation.
      await onComplete(result);
    } catch (error) {
      if (!container.isConnected) return;
      feedback.textContent = error.message;
      form.elements.code.value = '';
    } finally {
      busy = false; controls.forEach(control => control.disabled = false);
      if (container.isConnected) form.elements.code?.focus();
    }
  };
  container.querySelector('[data-cancel-mfa]').onclick = async () => {
    if (busy) return;
    busy = true;
    try { await api('/api/auth/mfa/cancel', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': state.csrfToken } }); }
    catch { /* A stale pending flow is already inaccessible. */ }
    container.replaceChildren(); onCancel();
  };
  form.elements.code.focus();
}
