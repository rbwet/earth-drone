<div align="center">

# 🚁 EARTH DRONE

### Fly the real planet.

An FPV drone & helicopter simulator over **Google Photorealistic 3D Tiles** —
the same photogrammetry behind Google Earth — streamed live through CesiumJS,
with Battlefield-style flight physics, a synthesized rotor soundtrack, and a
full glass-cockpit HUD.

Dive the Grand Canyon. Thread the towers of Dubai. Buzz your own street.

[![CesiumJS](https://img.shields.io/badge/CesiumJS-1.130-3b9cff?logo=cesium&logoColor=white)](https://cesium.com/platform/cesiumjs/)
[![Google 3D Tiles](https://img.shields.io/badge/Google-Photorealistic%203D%20Tiles-4285F4?logo=googlemaps&logoColor=white)](https://developers.google.com/maps/documentation/tile/3d-tiles)
[![WebGL2](https://img.shields.io/badge/WebGL2-native%20res%20%2B%20SSAA-990000?logo=webgl&logoColor=white)](#graphics--performance)
[![No build step](https://img.shields.io/badge/build-none%20%F0%9F%8E%89-success)](#quick-start)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## ✨ Highlights

- 🌍 **The whole Earth is the map** — photorealistic 3D cities, mountains, and
  coastlines streamed on demand. No downloads, no level files.
- 🔎 **Go anywhere by name or coordinates** — type "machu picchu", an address,
  `38.59, -90.35`, DMS copied from Wikipedia, or a pasted Google Maps URL into
  the search box (**G**), and spawn there at an altitude that fits the place.
- 🚁 **Two flight models, one keystroke apart** — *Little Bird*, a
  Battlefield-style helicopter (mouse cyclic, collective, rudder, coordinated
  turns, barrel rolls), and *OG Drone*, a fly-where-you-look FPV quad.
- 🎮 **Feel-first physics** — attitude inertia, momentum without ice-skating,
  managed gravity that punishes dives and hard banks but never fights you.
- ✦ **Enhance mode** — press **X** and the sim streams the deepest level of
  detail Google has for everything around you, layer by layer, with extra
  supersampling and a 3 GB tile cache. GPU-heavy by design; toggle off to
  give the frame rate back.
- ⊙ **Street View companion** — press **B** for the real panorama at the
  drone's position, filling in the facade detail aerial photogrammetry
  can't capture.
- 🔊 **Procedural rotor audio** — blade-pass thump and speed-reactive wind,
  synthesized entirely in WebAudio. Zero audio files.
- 🖥️ **Glass cockpit** — compass tape, speed with boost bar, AGL/MSL altitude,
  live coordinates, crosshair.
- ⚡ **Self-tuning performance** — an FPS governor trades tile detail for
  smoothness in real time, and detail scales *up* with airspeed.
- 🛡️ **Self-healing sim** — NaN watchdog, sanitized inputs, on-screen boot
  diagnostics, GPU/software-rendering detection.

## 🚀 Quick start

No build step — serve the folder, open the page, paste a key, fly.

```powershell
npm run dev          # static server on http://localhost:8080
# or
python -m http.server 8080
```

> **The one key you need (free):** either a
> [Google Maps Platform API key](https://developers.google.com/maps/documentation/tile/get-api-key)
> with the **Map Tiles API** enabled, or a
> [Cesium ion access token](https://ion.cesium.com/tokens).
> Paste it on the start screen — it lives only in your browser's localStorage.

Best in Chrome or Edge with hardware acceleration on. The help panel (**H**)
shows which GPU the browser actually gave you.

## 🕹️ Controls

Two flight models, toggled with **V** or the top-bar button.

|  | ⟠ **Little Bird** *(default)* | ◈ **OG Drone** |
| --- | --- | --- |
| **Mouse** | Cyclic — push forward = nose down, sideways = bank | Look / steer |
| **W / S** | Collective — climb / descend | Forward / backward (where you look) |
| **A / D** | Rudder — yaw | Strafe |
| **Space / C** | Collective (alias) | Climb / descend |
| **Shift** | Emergency power | Boost (~340 km/h, FOV kick) |

In Little Bird, attitude holds where you put it — a bank stays banked, barrel
rolls work — and a gentle hover assist levels the airframe only when you're
already near level. Nose angle sets your speed; flare to brake.

<details>
<summary><b>All shortcuts</b></summary>

| Key | Action |
| --- | --- |
| **V** | Toggle flight model |
| **G** | Search — place name, address, or coordinates |
| **X** | Enhance — stream maximum tile detail (GPU-heavy) |
| **B** | Street View panorama at your position |
| **1–9** | Teleport to landmarks (more in the dropdown) |
| **R** | Reset position |
| **T** | Cycle time of day |
| **M** | Mute rotor audio |
| **H** | Help overlay |
| **K** | Change API key |
| **Esc** | Release the mouse |

</details>

**Shareable spawns:** add `?loc=N` to the URL to start at any landmark —
`http://localhost:8080/?loc=4` drops you over the Grand Canyon.

## 🗺️ Destinations

Manhattan · Shibuya · the Eiffel Tower · Burj Khalifa · the Grand Canyon ·
Christ the Redeemer · the Golden Gate · Sydney Opera House · the Matterhorn ·
Old Webster (Webster Groves, MO) · downtown Clayton, MO — and anywhere you
fly to from there. Add your own in [`js/locations.js`](js/locations.js), or
just search: the **G** box geocodes free text via
[Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap, no key
needed, Photon fallback) and understands decimal degrees, DMS
(`48°51′29″N 2°17′40″E`), and Google Maps URLs. The destination's terrain
height is sampled from the 3D tiles before you spawn, so you arrive at a
sensible altitude whether it's a tower or a mountain town.

## 🎨 Graphics & performance

| Preset | Tile detail | AA | HDR | Render resolution |
| --- | --- | --- | --- | --- |
| Low | coarse | FXAA | — | 75% native |
| Medium | standard | FXAA | — | native |
| **High** *(default)* | 2× | 4× MSAA + FXAA | ✓ | **1.25× native (SSAA)** |
| Ultra | 4× | 4× MSAA + FXAA | ✓ | **2× native (SSAA)** |

Under the hood: rendering at true device pixels, atmospheric scattering with a
real sun position (press **T**), an FPS governor that relaxes tile detail when
frame rate dips and claws it back when there's headroom, speed-adaptive detail
(up to 45% more aggressive at full boost), and a 1.5 GB tile cache so circling
a building never re-streams it.

## 🧠 How it works

| Module | What it does |
| --- | --- |
| [`js/main.js`](js/main.js) | Cesium viewer (globe off — Google tiles *are* the planet), tileset bootstrap, quality presets, FPS governor, key handling, time-of-day |
| [`js/drone.js`](js/drone.js) | Both flight models in the local east-north-up frame, frame-rate-independent smoothing, NaN watchdog, collision via throttled `scene.sampleHeight` picks |
| [`js/controls.js`](js/controls.js) | Pointer lock + keyboard state, input sanitization |
| [`js/geocode.js`](js/geocode.js) | Coordinate parsing (decimal / DMS / Maps URLs) and free-text geocoding (Nominatim → Photon) |
| [`js/enhance.js`](js/enhance.js) | Enhance mode — progressive max-LOD streaming, supersampling bump, big tile cache |
| [`js/hud.js`](js/hud.js) | Compass tape, speed, altitude, coordinates |
| [`js/audio.js`](js/audio.js) | WebAudio rotor + wind synthesis |
| [`setkey.html`](setkey.html) | Stores an API key from the URL *fragment* — never touches the server or the source |

Flight-feel constants live at the top of `js/drone.js` (`HELI` and `FPV`)
with comments on every knob: body rates, chase rate, accel cap, sag, climb.

## 📜 Notes & license

- Tile streaming needs bandwidth — new areas sharpen over a few seconds.
- Google's attribution in the bottom bar is required by the
  [3D Tiles terms](https://developers.google.com/maps/documentation/tile/3d-tiles);
  leave it visible.
- Code is [MIT](LICENSE). Map data © Google and its providers.
