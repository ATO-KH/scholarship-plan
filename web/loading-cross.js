const TURN_MS = 1600;
const CYCLE_MS = TURN_MS + 1000;
const ARM_TRAVEL = 7;

export function crossMotion(elapsed) {
  const phase = Math.max(0, elapsed) % CYCLE_MS;
  if (phase >= TURN_MS) return { angle: 360, spread: 0 };
  const t = phase / TURN_MS;
  // Smooth acceleration/deceleration; the derivative peaks at the half turn.
  const progress = t ** 3 * (10 + t * (-15 + 6 * t));
  const speed = 16 * t ** 2 * (1 - t) ** 2;
  return { angle: 360 * progress, spread: ARM_TRAVEL * speed };
}

if (typeof customElements !== "undefined") {
  class LoadingCross extends HTMLElement {
    elapsed = 0;
    paused = false;
    visible = false;
    frame = 0;

    connectedCallback() {
      this.rotor = this.querySelector(".auth-cross-rotor");
      this.arms = [...this.querySelectorAll(".auth-cross-arm")];
      this.motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
      this.motionPreference.addEventListener("change", this.updatePlayback);
      document.addEventListener("visibilitychange", this.updatePlayback);
      this.observer = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        this.updatePlayback();
      });
      this.draw();
      this.observer.observe(this);
    }

    disconnectedCallback() {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.visible = false;
      this.observer.disconnect();
      this.motionPreference.removeEventListener("change", this.updatePlayback);
      document.removeEventListener("visibilitychange", this.updatePlayback);
    }

    draw() {
      const { angle, spread } = crossMotion(this.motionPreference.matches ? 0 : this.elapsed);
      // SVG coordinates are centered at (0,0). No CSS pivots or image bounds.
      this.rotor.setAttribute("transform", `rotate(${angle})`);
      for (const arm of this.arms) {
        arm.setAttribute("transform", `translate(0 ${-spread})`);
      }
    }

    tick = (now) => {
      this.elapsed = (now - this.startedAt) % CYCLE_MS;
      this.draw();
      this.frame = requestAnimationFrame(this.tick);
    };

    updatePlayback = () => {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (this.motionPreference.matches) {
        this.elapsed = 0;
        this.draw();
        return;
      }
      if (!this.visible || document.hidden || this.paused) return;
      this.startedAt = performance.now() - this.elapsed;
      this.frame = requestAnimationFrame(this.tick);
    };

    pauseAt(elapsed = this.elapsed) {
      this.paused = true;
      this.elapsed = Math.min(CYCLE_MS, Math.max(0, elapsed));
      this.draw();
      this.updatePlayback();
    }

    restart() {
      this.paused = false;
      this.elapsed = 0;
      this.draw();
      this.updatePlayback();
    }
  }

  customElements.define("ato-loading-cross", LoadingCross);
}
