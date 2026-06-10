import { LOCATIONS } from "./locations.js";
import { Controls } from "./controls.js";
import { Drone } from "./drone.js";
import { Hud } from "./hud.js";
import { RotorAudio } from "./audio.js";

const KEY_STORAGE = "earthdrone.apikey";

// sse = tileset maximumScreenSpaceError (higher = fewer triangles/tiles).
// HDR and MSAA are reserved for machines that pick High/Ultra themselves.
// scale multiplies native device resolution: >1 = supersampling (SSAA).
const QUALITY = {
  low:    { sse: 36, msaa: 1, hdr: false, scale: 0.75 },
  medium: { sse: 16, msaa: 1, hdr: false, scale: 1 },
  high:   { sse: 8,  msaa: 4, hdr: true,  scale: 1.25 },
  ultra:  { sse: 4,  msaa: 4, hdr: true,  scale: 2 },
};
let baseSSE = QUALITY.medium.sse;
let governedSSE = baseSSE; // FPS governor moves this; speed scaling applies on top
// Optional default key baked in at deploy time — when empty, the start
// screen asks for a Google Maps API key or Cesium ion token instead.
const DEFAULT_KEY = "";
const TIMES_LOCAL = [9, 13, 17.5, 20]; // local solar hours cycled by T

const els = {
  modal: document.getElementById("keyModal"),
  keyInput: document.getElementById("keyInput"),
  keyGo: document.getElementById("keyGo"),
  keyError: document.getElementById("keyError"),
  loading: document.getElementById("loading"),
  hud: document.getElementById("hud"),
  topBar: document.getElementById("topBar"),
  helpPanel: document.getElementById("helpPanel"),
  helpBtn: document.getElementById("helpBtn"),
  clickToFly: document.getElementById("clickToFly"),
  locSelect: document.getElementById("locSelect"),
  qualitySelect: document.getElementById("qualitySelect"),
  locName: document.getElementById("locName"),
};

let viewer, drone, controls, hud, audio, tileset;

// Which adapter did the browser actually give us? "SwiftShader" or
// "Basic Render" here means software rendering — the #1 cause of lag.
function gpuRenderer() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return "no WebGL at all";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  } catch (e) {
    return "unknown";
  }
}
let currentLoc = 0;
let timeIdx = 1;
let locNameTimer;

function showError(msg) {
  els.keyError.textContent = msg;
  els.keyError.classList.remove("hidden");
}

function isIonToken(key) {
  return key.startsWith("ey") && key.split(".").length === 3;
}

async function init(key) {
  els.modal.classList.add("hidden");
  els.loading.classList.remove("hidden");

  const gpu = gpuRenderer();
  console.log("[EarthDrone] WebGL renderer:", gpu);
  document.getElementById("gpuInfo").textContent = "GPU: " + gpu;
  const software = /swiftshader|basic render|software|llvmpipe/i.test(gpu);
  if (software) {
    document.getElementById("gpuWarn").classList.remove("hidden");
  }

  viewer = new Cesium.Viewer("cesiumContainer", {
    globe: false,             // Google tiles cover the whole planet
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    skyAtmosphere: new Cesium.SkyAtmosphere(),
    contextOptions: { webgl: { antialias: false, powerPreference: "high-performance" } },
  });

  // Render at real device pixels (not CSS pixels) — resolutionScale then
  // multiplies on top of that for supersampling.
  viewer.useBrowserRecommendedResolution = false;

  const scene = viewer.scene;
  scene.skyAtmosphere.show = true;
  scene.postProcessStages.fxaa.enabled = true;
  scene.screenSpaceCameraController.enableInputs = false;
  scene.camera.frustum.near = 0.3; // don't clip when skimming rooftops

  try {
    if (isIonToken(key)) {
      Cesium.Ion.defaultAccessToken = key;
      tileset = await Cesium.createGooglePhotorealistic3DTileset();
    } else {
      Cesium.GoogleMaps.defaultApiKey = key;
      tileset = await Cesium.createGooglePhotorealistic3DTileset();
    }
  } catch (err) {
    viewer.destroy();
    viewer = undefined;
    els.loading.classList.add("hidden");
    els.modal.classList.remove("hidden");
    showError(`Couldn't load Google 3D Tiles: ${err.message ?? err}. ` +
      "Check that the key is valid and the Map Tiles API is enabled.");
    localStorage.removeItem(KEY_STORAGE);
    return;
  }

  // skipLevelOfDetail and foveated loading both trade visual stability for
  // streaming speed — they show up as flicker/holes while yawing. Off.
  tileset.skipLevelOfDetail = false;
  tileset.foveatedScreenSpaceError = false;
  tileset.dynamicScreenSpaceError = false;
  tileset.cacheBytes = 1536 * 1024 * 1024;
  tileset.maximumCacheOverflowBytes = 1536 * 1024 * 1024;
  scene.primitives.add(tileset);
  applyQuality(els.qualitySelect.value);

  // --- Wiring ---
  controls = new Controls(viewer.canvas);
  drone = new Drone(scene, controls);
  hud = new Hud();
  audio = new RotorAudio();

  viewer.canvas.addEventListener("click", () => audio.start());

  controls.onTeleport = teleport;
  controls.onReset = () => teleport(currentLoc);
  controls.onToggleHelp = () => els.helpPanel.classList.toggle("hidden");
  controls.onCycleTime = cycleTime;
  controls.onToggleMute = () => audio.toggleMute();
  controls.onChangeKey = changeKey;

  document.addEventListener("flightlock", (e) => {
    els.clickToFly.classList.toggle("hidden", e.detail);
    if (e.detail) els.helpPanel.classList.add("hidden");
  });

  els.locSelect.addEventListener("change", () => {
    teleport(Number(els.locSelect.value));
    els.locSelect.blur();
  });
  els.qualitySelect.addEventListener("change", () => {
    applyQuality(els.qualitySelect.value);
    els.qualitySelect.blur();
  });
  els.helpBtn.addEventListener("click", () => els.helpPanel.classList.toggle("hidden"));

  teleport(0);
  setLocalTime(TIMES_LOCAL[timeIdx]);

  // --- Flight loop + FPS governor ---
  // If the frame rate tanks, trade tile detail for smoothness; claw the
  // detail back when there's headroom.
  let last = performance.now();
  let fpsFrames = 0, fpsTime = 0;
  scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const state = drone.update(dt);
    hud.update(state);
    audio.update(state.throttle, state.speedFrac);

    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 1.5) {
      const fps = fpsFrames / fpsTime;
      fpsFrames = 0;
      fpsTime = 0;
      if (fps < 25) {
        governedSSE = Math.min(64, governedSSE * 1.4);
      } else if (fps > 50 && governedSSE > baseSSE) {
        governedSSE = Math.max(baseSSE, governedSSE * 0.8);
      }
    }
    // Speed-adaptive detail: request more tile detail the faster you fly,
    // up to 45% more aggressive at full boost. The governor still wins if
    // the frame rate can't keep up.
    tileset.maximumScreenSpaceError =
      Math.max(2, governedSSE * (1 - 0.45 * state.speedFrac));
  });

  const hideLoading = () => {
    els.loading.classList.add("hidden");
    els.hud.classList.remove("hidden");
    els.topBar.classList.remove("hidden");
    els.clickToFly.classList.remove("hidden");
  };
  tileset.initialTilesLoaded.addEventListener(hideLoading);
  setTimeout(hideLoading, 15000); // fallback if the event never fires
}

function teleport(i) {
  if (i < 0 || i >= LOCATIONS.length) return;
  currentLoc = i;
  const l = LOCATIONS[i];
  drone.setPose(l.lon, l.lat, l.height, l.heading, l.pitch);
  els.locSelect.value = String(i);
  els.locName.textContent = l.name.toUpperCase();
  els.locName.style.opacity = "0.95";
  clearTimeout(locNameTimer);
  locNameTimer = setTimeout(() => { els.locName.style.opacity = "0"; }, 4000);
  setLocalTime(TIMES_LOCAL[timeIdx]);
}

// Pick a UTC time so the *local solar* time at the drone is roughly `hours`.
function setLocalTime(hours) {
  const lonDeg = LOCATIONS[currentLoc].lon;
  let utc = hours - lonDeg / 15;
  utc = ((utc % 24) + 24) % 24;
  const hh = String(Math.floor(utc)).padStart(2, "0");
  const mm = String(Math.floor((utc % 1) * 60)).padStart(2, "0");
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(`2026-06-21T${hh}:${mm}:00Z`);
  viewer.clock.shouldAnimate = false;
}

function cycleTime() {
  timeIdx = (timeIdx + 1) % TIMES_LOCAL.length;
  setLocalTime(TIMES_LOCAL[timeIdx]);
}

function applyQuality(name) {
  const q = QUALITY[name] ?? QUALITY.medium;
  baseSSE = q.sse;
  governedSSE = q.sse;
  tileset.maximumScreenSpaceError = q.sse;
  viewer.scene.msaaSamples = q.msaa;
  viewer.scene.highDynamicRange = q.hdr;
  viewer.resolutionScale = q.scale;
}

function changeKey() {
  // Empty string = "show the key screen", overriding the built-in default.
  localStorage.setItem(KEY_STORAGE, "");
  location.reload();
}

// --- Boot ---
for (let i = 0; i < LOCATIONS.length; i++) {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = `${i + 1}. ${LOCATIONS[i].name}`;
  els.locSelect.appendChild(opt);
}

const stored = localStorage.getItem(KEY_STORAGE);
const bootKey = stored || DEFAULT_KEY;
if (bootKey) {
  init(bootKey);
} else {
  els.modal.classList.remove("hidden"); // no saved key (or user pressed K)
}

els.keyGo.addEventListener("click", () => {
  const key = els.keyInput.value.trim();
  if (key.length < 20) {
    showError("That doesn't look like a valid key.");
    return;
  }
  localStorage.setItem(KEY_STORAGE, key);
  init(key);
});

els.keyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.keyGo.click();
});
