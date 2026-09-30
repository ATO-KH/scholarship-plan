// Every waiting state uses the same centered SVG geometry and motion component.
(() => {
  const escape = (text) => String(text).replace(/[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const arm = 'M-50.5-75.5H50.5L20.849-31.17A37.5 37.5 0 0 0-20.849-31.17Z';
  const cross = () => document.querySelector("#auth-loading .auth-cross")?.outerHTML ||
    `<ato-loading-cross class="auth-cross" aria-hidden="true"><svg viewBox="-84 -84 168 168" width="152" height="152" focusable="false"><g class="auth-cross-rotor" fill="currentColor">${[0, 90, 180, 270].map((angle) => `<g transform="rotate(${angle})"><path class="auth-cross-arm" d="${arm}" /></g>`).join("")}</g><circle class="auth-cross-center" cx="0" cy="0" r="26.5" fill="none" stroke="currentColor" stroke-width="10" /></svg></ato-loading-cross>`;
  let count = 0, indicator;
  const markup = (message = "Loading…", compact = false) =>
    `<span class="loading-state${compact ? " loading-state-compact" : ""}" role="status" aria-live="polite">${cross()}<span>${escape(message)}</span></span>`;
  window.atoLoading = {
    markup,
    begin(message = "Loading…") {
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "request-loading";
        indicator.innerHTML = markup(message, true);
        document.body.append(indicator);
      }
      if (count === 0) indicator.querySelector(".loading-state > span").textContent = message;
      count++;
      indicator.hidden = false;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        count = Math.max(0, count - 1);
        indicator.hidden = count === 0;
      };
    },
  };
})();
