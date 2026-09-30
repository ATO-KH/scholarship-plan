const TURN_MS = 1600;
const CYCLE_MS = TURN_MS + 1000;
const ARM_TRAVEL = 7;
const ARM_STEP_MS = TURN_MS / 4;
const CLOCKWISE_FROM_BOTTOM = [2, 3, 0, 1];

export function crossMotion(elapsed) {
  const phase = Math.max(0, elapsed) % CYCLE_MS;
  if (phase >= TURN_MS) return { angle: 360, spread: 0 };
  const t = phase / TURN_MS;
  // Smooth acceleration/deceleration; the derivative peaks at the half turn.
  const progress = t ** 3 * (10 + t * (-15 + 6 * t));
  const speed = 16 * t ** 2 * (1 - t) ** 2;
  return { angle: 360 * progress, spread: ARM_TRAVEL * speed };
}

export function crossSequence(elapsed) {
  const phase = Math.max(0, elapsed) % CYCLE_MS;
  const spreads = [0, 0, 0, 0];
  if (phase < TURN_MS) {
    const step = Math.floor(phase / ARM_STEP_MS);
    const t = (phase % ARM_STEP_MS) / ARM_STEP_MS;
    spreads[CLOCKWISE_FROM_BOTTOM[step]] = ARM_TRAVEL * 16 * t ** 2 * (1 - t) ** 2;
  }
  return spreads;
}

if (typeof customElements !== "undefined") {
  class LoadingCross extends HTMLElement {
    elapsed = 0;
    paused = false;
    visible = false;
    frame = 0;
    variant = "spin";

    connectedCallback() {
      this.rotor = this.querySelector(".auth-cross-rotor");
      this.arms = [...this.querySelectorAll(".auth-cross-arm")];
      this.motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
      this.motionPreference.addEventListener("change", this.updatePlayback);
      document.addEventListener("visibilitychange", this.updatePlayback);
      this.observer = new IntersectionObserver(([entry]) => {
        const appeared = entry.isIntersecting && !this.visible;
        this.visible = entry.isIntersecting;
        if (appeared && !this.paused) {
          this.chooseAnimation();
          this.elapsed = 0;
          this.draw();
        }
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
      const elapsed = this.motionPreference.matches ? 0 : this.elapsed;
      const { angle, spread } = crossMotion(elapsed);
      const sequence = this.variant === "sequence";
      const spreads = sequence ? crossSequence(elapsed) : [spread, spread, spread, spread];
      // SVG coordinates are centered at (0,0). No CSS pivots or image bounds.
      this.rotor.setAttribute("transform", `rotate(${sequence ? 0 : angle})`);
      this.arms.forEach((arm, index) => {
        arm.setAttribute("transform", `translate(0 ${-spreads[index]})`);
      });
    }

    chooseAnimation() {
      const preference = this.getAttribute("animation");
      this.variant = ["spin", "sequence"].includes(preference)
        ? preference
        : Math.random() < 0.5 ? "spin" : "sequence";
      this.setAttribute("data-cross-animation", this.variant);
    }

    setAnimation(preference) {
      this.setAttribute("animation", ["spin", "sequence"].includes(preference) ? preference : "random");
      this.chooseAnimation();
      this.restart();
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
