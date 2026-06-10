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
const RAMP = 0.55;       // SSE multiplier per fully-loaded step
const MIN_SCALE = 1.5;   // at least this much supersampling while active
const CACHE_BYTES = 3 * 1024 * 1024 * 1024; // hold the whole area in VRAM

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
    this.saved = {
      scale: this.viewer.resolutionScale,
      cacheBytes: this.tileset.cacheBytes,
      overflowBytes: this.tileset.maximumCacheOverflowBytes,
    };
    this.tileset.cacheBytes = CACHE_BYTES;
    this.tileset.maximumCacheOverflowBytes = CACHE_BYTES;
    this.viewer.resolutionScale = Math.max(this.saved.scale, MIN_SCALE);
    this.statusTimer = 0;
    this.statusEl.classList.remove("hidden");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.viewer.resolutionScale = this.saved.scale;
    this.tileset.cacheBytes = this.saved.cacheBytes;
    this.tileset.maximumCacheOverflowBytes = this.saved.overflowBytes;
    this.statusEl.classList.add("hidden");
  }

  // After a teleport the old ramp state is for the old skyline.
  restart(fromSSE) {
    if (!this.active) return;
    this.startSSE = Math.max(fromSSE, MIN_SSE + 0.001);
    this.sse = this.startSSE;
  }

  // Called every frame while active; owns maximumScreenSpaceError.
  tick(dt) {
    const t = this.tileset;
    if (t.tilesLoaded && this.sse > MIN_SSE) {
      this.sse = Math.max(MIN_SSE, this.sse * RAMP);
    }
    t.maximumScreenSpaceError = this.sse;

    this.statusTimer -= dt;
    if (this.statusTimer > 0) return;
    this.statusTimer = 0.25;

    const stats = t.statistics;
    const pending = (stats?.numberOfPendingRequests ?? 0)
      + (stats?.numberOfTilesProcessing ?? 0);
    if (this.sse <= MIN_SSE && t.tilesLoaded) {
      this.statusEl.textContent = "✦ MAX DETAIL — everything Google has is loaded";
    } else {
      // Progress through the ramp, measured in LOD halvings completed.
      const total = Math.log(this.startSSE / MIN_SSE);
      const done = Math.log(this.startSSE / this.sse);
      const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 99;
      this.statusEl.textContent =
        `✦ ENHANCING ${pct}% — ${pending} tiles streaming`;
    }
  }
}
