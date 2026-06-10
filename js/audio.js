// Procedural rotor/wind audio with WebAudio: filtered noise (wind) +
// a pulsed low-frequency buzz (rotor). Pitch and volume track throttle.
export class RotorAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.throttle = 0; // 0..1 smoothed externally
  }

  // Must be called from a user gesture (click) to satisfy autoplay policy.
  start() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // --- Rotor: sawtooth through a lowpass, amplitude-modulated by blade passes
    this.rotorOsc = ctx.createOscillator();
    this.rotorOsc.type = "sawtooth";
    this.rotorOsc.frequency.value = 55;

    this.rotorLP = ctx.createBiquadFilter();
    this.rotorLP.type = "lowpass";
    this.rotorLP.frequency.value = 420;

    this.bladeLFO = ctx.createOscillator();
    this.bladeLFO.frequency.value = 24;
    this.bladeDepth = ctx.createGain();
    this.bladeDepth.gain.value = 0.45;

    this.rotorGain = ctx.createGain();
    this.rotorGain.gain.value = 0.5;

    this.bladeLFO.connect(this.bladeDepth);
    this.bladeDepth.connect(this.rotorGain.gain);
    this.rotorOsc.connect(this.rotorLP);
    this.rotorLP.connect(this.rotorGain);
    this.rotorGain.connect(this.master);

    // --- Wind: white noise through a bandpass that opens with speed
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf;
    this.noise.loop = true;

    this.windBP = ctx.createBiquadFilter();
    this.windBP.type = "bandpass";
    this.windBP.frequency.value = 300;
    this.windBP.Q.value = 0.6;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.2;

    this.noise.connect(this.windBP);
    this.windBP.connect(this.windGain);
    this.windGain.connect(this.master);

    this.rotorOsc.start();
    this.bladeLFO.start();
    this.noise.start();
  }

  // throttle 0..1 (hover ~0.35), speedFrac 0..1 of max speed
  update(throttle, speedFrac) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const vol = 0.10 + throttle * 0.16;
    this.master.gain.setTargetAtTime(vol, t, 0.08);
    this.rotorOsc.frequency.setTargetAtTime(48 + throttle * 38, t, 0.1);
    this.bladeLFO.frequency.setTargetAtTime(20 + throttle * 18, t, 0.1);
    this.rotorLP.frequency.setTargetAtTime(380 + throttle * 700, t, 0.1);
    this.windBP.frequency.setTargetAtTime(250 + speedFrac * 1400, t, 0.15);
    this.windGain.gain.setTargetAtTime(0.05 + speedFrac * 0.5, t, 0.15);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx && this.muted) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }
}
