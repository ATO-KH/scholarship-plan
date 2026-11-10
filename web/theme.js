"use strict";
(() => {
  const key = "ato-scholarship-theme";
  let theme = "dark";
  try {
    if (localStorage.getItem(key) === "light") theme = "light";
  } catch {}
  document.documentElement.dataset.theme = theme;

  document.addEventListener("DOMContentLoaded", () => {
    const control = document.querySelector("#theme-toggle");
    if (!control) return;
    const choices = control.querySelectorAll('input[name="portal-theme"]');
    const update = () => {
      for (const choice of choices) choice.checked = choice.value === document.documentElement.dataset.theme;
    };
    for (const choice of choices) choice.addEventListener("change", () => {
      if (!choice.checked) return;
      document.documentElement.dataset.theme = choice.value;
      try { localStorage.setItem(key, choice.value); } catch {}
      update();
    });
    update();
  });
})();

// A click adds angular velocity; exponential drag smoothly dissipates it.
document.addEventListener("DOMContentLoaded", () => {
  const button = document.querySelector(".brand-spin");
  const art = button?.querySelector(".brand-spin-art");
  if (!art) return;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let angle = 0, velocity = 0, previous = 0, frame = 0;
  const drag = 0.85;
  const advance = (now) => {
    const dt = Math.max(0, (now - previous) / 1000);
    previous = now;
    const decay = Math.exp(-drag * dt);
    angle = (angle + velocity * (1 - decay) / drag) % 360;
    velocity *= decay;
    art.style.transform = `rotate(${angle}deg)`;
  };
  const tick = (now) => {
    advance(now);
    if (velocity > 0.5) frame = requestAnimationFrame(tick);
    else { velocity = 0; frame = 0; }
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    velocity = 0;
  };
  button.addEventListener("click", () => {
    if (reducedMotion.matches) return;
    const now = performance.now();
    if (frame) advance(now);
    else previous = now;
    velocity = Math.min(velocity + 300, 2160);
    if (!frame) frame = requestAnimationFrame(tick);
  });
  reducedMotion.addEventListener("change", stop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
  });
});
