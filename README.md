# Earth Drone

An FPV drone simulator that uses the real planet as its map. It streams
**Google Photorealistic 3D Tiles** — the same photogrammetry data behind
Google Earth — through CesiumJS, and layers a custom flight model on top:
banked turns, inertia, boost, ground collision, and a synthesized rotor
soundtrack. Fly over Manhattan, dive the Grand Canyon, orbit the Eiffel
Tower.

## Run it

No build step. Serve the folder with any static server:

```powershell
npm run dev          # uses npx serve on http://localhost:8080
# or
python -m http.server 8080
```

Then open http://localhost:8080 in Chrome or Edge (best WebGL2 performance).

## You need one key (free)

The Google 3D Tiles stream requires a key. Either works — paste it into the
start screen (it's stored only in your browser's localStorage):

- **Google Maps Platform API key** with the **Map Tiles API** enabled —
  [get one here](https://developers.google.com/maps/documentation/tile/get-api-key).
  The free monthly tier covers a lot of flying.
- **Cesium ion access token** — [ion.cesium.com/tokens](https://ion.cesium.com/tokens)
  (routes the same Google tiles through Cesium's proxy).

## Controls

Two flight models, toggled with **V**. The default is **Little Bird** —
Battlefield-style helicopter controls: the mouse is the cyclic and all
horizontal motion comes from tilting the airframe.

| Input | Little Bird (default) | FPV drone (V) |
| --- | --- | --- |
| Mouse | Cyclic — push forward = nose down, sideways = bank | Look / steer |
| W / S | Collective — climb / descend | Forward / backward (where you look) |
| A / D | Rudder — yaw | Strafe |
| Space / C | Collective (alias) | Climb / descend |
| Shift | Emergency power | Boost (~340 km/h, FOV kick) |

Attitude holds where you put it — bank stays banked, barrel rolls work; a
gentle hover assist levels the airframe only when you're already near level.

| Input | Action |
| --- | --- |
| V | Toggle flight model |
| 1–9 | Teleport to landmarks |
| R | Reset position |
| T | Cycle time of day |
| M | Mute rotor audio |
| H | Help overlay |
| K | Change API key |
| Esc | Release the mouse |

## Tuning

- Graphics quality dropdown (top left) maps to the tileset's
  `maximumScreenSpaceError` — Ultra also renders at native device resolution.
- Flight feel constants live in `js/drone.js` (`HELI` and `FPV`): body
  rates, lift, drag, hover assist, FOV kick.
- Add your own spawn points in `js/locations.js`.

## How it works

- `js/main.js` — Cesium viewer setup (globe disabled, HDR, MSAA 4x, FXAA),
  Google tileset bootstrap, key handling, time-of-day.
- `js/drone.js` — velocity-based flight model in the local east-north-up
  frame, frame-rate-independent smoothing, collision via `scene.sampleHeight`
  against the loaded tiles.
- `js/controls.js` — pointer lock + keyboard state.
- `js/hud.js` — speed/altitude/compass HUD.
- `js/audio.js` — WebAudio rotor + wind synthesis (no audio files).

Tile streaming needs bandwidth; the first seconds at a new location look
blurry while detail loads. Google's attribution in the bottom bar is a
requirement of the tiles' terms of use — leave it visible.
