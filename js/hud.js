// DOM HUD: speed, altitude, coordinates, compass tape, boost bar.
const CARDINALS = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
const TICK_PX = 60;   // px per 15° tick on the compass tape
const TICK_DEG = 15;

export class Hud {
  constructor() {
    this.speedVal = document.getElementById("speedVal");
    this.aglVal = document.getElementById("aglVal");
    this.mslVal = document.getElementById("mslVal");
    this.coordsVal = document.getElementById("coordsVal");
    this.boostFill = document.getElementById("boostFill");
    this.tape = document.getElementById("compassTape");
    this.compassWidth = 340;
    this.buildTape();
    this.frame = 0;
  }

  buildTape() {
    // Three copies of 0..345° so the tape can wrap seamlessly.
    let html = "";
    for (let rep = 0; rep < 3; rep++) {
      for (let deg = 0; deg < 360; deg += TICK_DEG) {
        const label = CARDINALS[deg] ?? String(deg).padStart(3, "0");
        const cls = CARDINALS[deg] ? ' class="cardinal"' : "";
        html += `<span${cls}>${label}</span>`;
      }
    }
    this.tape.innerHTML = html;
  }

  update(s) {
    // Compass moves every frame for smoothness; numbers throttle to ~10 Hz.
    const degPerPx = TICK_DEG / TICK_PX;
    const headingDeg = (s.heading * 180) / Math.PI;
    const center = (360 + headingDeg) / degPerPx; // px into the middle copy
    this.tape.style.transform =
      `translateX(${this.compassWidth / 2 - center - TICK_PX / 2}px)`;

    if (this.frame++ % 6 !== 0) return;

    this.speedVal.textContent = Math.round(s.hSpeed * 3.6);
    this.mslVal.textContent = Math.round(s.heightMSL);
    this.aglVal.textContent =
      s.heightAGL !== undefined ? Math.max(0, Math.round(s.heightAGL)) : "—";
    this.coordsVal.textContent = `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
    this.boostFill.style.width = `${Math.round(s.speedFrac * 100)}%`;
  }
}
