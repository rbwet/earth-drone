// Keyboard + pointer-lock mouse input. Exposes a polled state object and
// accumulates mouse deltas between physics frames.
export class Controls {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.sensitivity = 0.0021; // radians per pixel

    this.onTeleport = null;  // (index) => void
    this.onReset = null;
    this.onToggleHelp = null;
    this.onCycleTime = null;
    this.onToggleMute = null;
    this.onChangeKey = null;
    this.onToggleMode = null;
    this.onGoTo = null;      // focus the location search box
    this.onEnhance = null;   // toggle max-detail streaming
    this.onStreetView = null;

    canvas.addEventListener("click", () => {
      if (!this.locked) canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.keys.clear();
      document.dispatchEvent(new CustomEvent("flightlock", { detail: this.locked }));
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      // movementX/Y can be undefined or huge garbage around pointer-lock
      // transitions on some devices — never let that into the physics.
      const mx = e.movementX, my = e.movementY;
      if (Number.isFinite(mx) && Math.abs(mx) < 1000) this.mouseDX += mx;
      if (Number.isFinite(my) && Math.abs(my) < 1000) this.mouseDY += my;
    });

    document.addEventListener("keydown", (e) => {
      // Don't swallow keys while typing in the API-key field.
      if (e.target instanceof HTMLInputElement) return;

      const code = e.code;
      if (code === "KeyH") { this.onToggleHelp?.(); e.preventDefault(); return; }
      if (code === "KeyK") { this.onChangeKey?.(); return; }
      if (code === "KeyG") { this.onGoTo?.(); e.preventDefault(); return; }
      if (code === "KeyX") { this.onEnhance?.(); return; }
      if (code === "KeyB") { this.onStreetView?.(); return; }

      if (!this.locked) return;

      if (code.startsWith("Digit")) {
        const n = parseInt(code.slice(5), 10);
        if (n >= 1 && n <= 9) this.onTeleport?.(n - 1);
        return;
      }
      if (code === "KeyR") { this.onReset?.(); return; }
      if (code === "KeyT") { this.onCycleTime?.(); return; }
      if (code === "KeyM") { this.onToggleMute?.(); return; }
      if (code === "KeyV") { this.onToggleMode?.(); return; }

      this.keys.add(code);
      if (code === "Space" || code === "ShiftLeft") e.preventDefault();
    });

    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  // Returns accumulated mouse deltas since last call and clears them.
  consumeMouse() {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  down(code) { return this.keys.has(code); }

  get axes() {
    const k = (c) => (this.keys.has(c) ? 1 : 0);
    const clamp1 = (v) => Math.max(-1, Math.min(1, v));
    return {
      // FPV model
      forward: k("KeyW") - k("KeyS"),
      strafe: k("KeyD") - k("KeyA"),
      vertical: k("Space") - (k("KeyC") + k("ControlLeft") > 0 ? 1 : 0),
      // Heli (Battlefield) model: W/S collective, A/D rudder.
      // Space/C/Ctrl also work as collective for muscle memory.
      collective: clamp1(k("KeyW") + k("Space")
        - (k("KeyS") + k("KeyC") + k("ControlLeft") > 0 ? 1 : 0)),
      yaw: k("KeyD") - k("KeyA"),
      boost: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
    };
  }
}
