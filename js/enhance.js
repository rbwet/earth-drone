// ENHANCE mode: stream the deepest tile detail Google has for wherever
// you're looking, GPU cost be damned.
//
// The tileset normally renders at maximumScreenSpaceError 4-36 (quality
// preset) with an FPS governor backing detail off under load. Enhance
// bypasses all of that: starting from the current detail level it waits
// for the scene to finish loading, then halves the error target and
// streams again, stepping down until SSE 1 — the finest LOD in the
// dataset. Ramping instead of jumping straight to 1 keeps the streaming
// queue shallow so the view sharpens visibly layer by layer, the same
// way the user sees it "render in". Supersampling is also raised so the
// extra geometry actually lands on extra pixels.
//
// Moving to a new area while active restarts the ramp there.

const MIN_SSE = 1;       // deepest LOD the tileset will serve
const RAMP = 0.55;       // SSE multiplier per step
const CACHE_BYTES = 6 * 1024 * 1024 * 1024; // tile retention ceiling — the
// cache fills as you explore, so several neighborhoods stay resident and
// flying back over them costs nothing. Demand-driven: an unexplored spot
// won't fill it, and that's correct.
const MSAA_SAMPLES = 8; // multisampled targets at 3x scale eat real VRAM

// Adaptive supersampling: vsync caps the frame *rate*, so a GPU that
// finishes early just idles — the only way to use the headroom is to
// make each frame heavier. Starting from MIN_SCALE, the render scale
// steps up while the frame rate holds near refresh and steps back down
// if it sags, settling wherever the GPU becomes the limit. Capped so
// the framebuffer never exceeds ~8k on its long edge.
const SCALE_MIN = 1.5;     // floor while enhance is active — but never
                           // below the user's own preset scale, so
                           // enhance can't render *smaller* than normal
const SCALE_MAX = 3.0;     // 9x the pixels of native — plenty
const SCALE_STEP = 0.25;
const TUNE_WINDOW = 1.25;  // s of FPS averaging per decision
const FPS_UP = 55;         // at/above this: GPU has headroom, push harder
const FPS_DOWN = 30;       // below this: too heavy, back off — enhance is
                           // explicitly allowed to be laggy, so only truly
                           // unflyable frame rates retreat

// tilesLoaded almost never settles to true over a dense area — the idle
// hover wobble alone keeps a trickle of requests in flight forever. So a
// layer counts as "in" when the stream has mostly drained, after a short
// dwell so a just-lowered SSE has time to issue its requests; a hard
// timeout guarantees the ramp always reaches the bottom regardless.
const SETTLE_PENDING = 6; // ...this many in-flight tiles ≈ drained
const STEP_DWELL = 1.0;   // s — minimum time per layer
const STEP_TIMEOUT = 8;   // s — maximum time per layer

export class Enhance {
  constructor(viewer, tileset, statusEl) {
    this.viewer = viewer;
    this.tileset = tileset;
    this.statusEl = statusEl;
    this.active = false;
    this.statusTimer = 0;
  }

  start(fromSSE) {
    this.active = true;
    this.startSSE = Math.max(fromSSE, MIN_SSE + 0.001);
    this.sse = this.startSSE;
    const scene = this.viewer.scene;
    this.saved = {
      scale: this.viewer.resolutionScale,
      cacheBytes: this.tileset.cacheBytes,
      overflowBytes: this.tileset.maximumCacheOverflowBytes,
      msaa: scene.msaaSamples,
      hdr: scene.highDynamicRange,
    };
    this.tileset.cacheBytes = CACHE_BYTES;
    this.tileset.maximumCacheOverflowBytes = CACHE_BYTES;
    scene.msaaSamples = MSAA_SAMPLES; // Cesium clamps to what the GPU supports
    scene.highDynamicRange = true;

    // Framebuffer guard: never push the render target past ~8k pixels
    // on its long edge, whatever the screen and devicePixelRatio are.
    this.scaleCap = SCALE_MAX;
    const canvas = this.viewer.canvas;
    if (canvas && typeof window !== "undefined") {
      const native = Math.max(canvas.clientWidth || 0, canvas.clientHeight || 0)
        * (window.devicePixelRatio || 1);
      if (native > 0) this.scaleCap = Math.min(SCALE_MAX, 8192 / native);
    }
    this.scaleFloor = Math.min(Math.max(this.saved.scale, SCALE_MIN), this.scaleCap);
    this.scale = this.scaleFloor;
    this.viewer.resolutionScale = this.scale;

    this.statusTimer = 0;
    this.stepTimer = 0;
    this.fpsFrames = 0;
    this.fpsTime = 0;
    this.statusEl.classList.remove("hidden");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.viewer.resolutionScale = this.saved.scale;
    this.tileset.cacheBytes = this.saved.cacheBytes;
    this.tileset.maximumCacheOverflowBytes = this.saved.overflowBytes;
    this.viewer.scene.msaaSamples = this.saved.msaa;
    this.viewer.scene.highDynamicRange = this.saved.hdr;
    this.statusEl.classList.add("hidden");
  }

  // After a teleport the old ramp state is for the old skyline.
  restart(fromSSE) {
    if (!this.active) return;
    this.startSSE = Math.max(fromSSE, MIN_SSE + 0.001);
    this.sse = this.startSSE;
    this.stepTimer = 0;
  }

  // Called every frame while active; owns maximumScreenSpaceError.
  tick(dt) {
    const t = this.tileset;
    const stats = t.statistics;
    const pending = (stats?.numberOfPendingRequests ?? 0)
      + (stats?.numberOfTilesProcessing ?? 0);

    this.stepTimer += dt;
    if (this.sse > MIN_SSE) {
      const settled = t.tilesLoaded || pending <= SETTLE_PENDING;
      if ((settled && this.stepTimer >= STEP_DWELL)
          || this.stepTimer >= STEP_TIMEOUT) {
        this.sse = Math.max(MIN_SSE, this.sse * RAMP);
        this.stepTimer = 0;
      }
    }
    t.maximumScreenSpaceError = this.sse;

    // Supersampling auto-tuner: convert spare frame time into pixels.
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= TUNE_WINDOW) {
      const fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
      if (fps >= FPS_UP && this.scale < this.scaleCap) {
        this.scale = Math.min(this.scaleCap, this.scale + SCALE_STEP);
        this.viewer.resolutionScale = this.scale;
      } else if (fps < FPS_DOWN && this.scale > this.scaleFloor) {
        this.scale = Math.max(this.scaleFloor, this.scale - SCALE_STEP);
        this.viewer.resolutionScale = this.scale;
      }
    }

    this.statusTimer -= dt;
    if (this.statusTimer > 0) return;
    this.statusTimer = 0.25;

    const residentGB = (t.totalMemoryUsageInBytes ?? 0) / 1024 ** 3;
    const scaleTag = `${this.scale.toFixed(2)}× render • ${residentGB.toFixed(2)} GB tiles`;
    if (this.sse <= MIN_SSE && (t.tilesLoaded || pending <= SETTLE_PENDING)) {
      this.statusEl.textContent =
        `✦ MAX DETAIL — everything Google has is loaded • ${scaleTag}`;
    } else {
      // Progress through the ramp, measured in LOD halvings completed.
      const total = Math.log(this.startSSE / MIN_SSE);
      const done = Math.log(this.startSSE / this.sse);
      const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 99;
      this.statusEl.textContent =
        `✦ ENHANCING ${pct}% — ${pending} tiles streaming • ${scaleTag}`;
    }
  }
}
