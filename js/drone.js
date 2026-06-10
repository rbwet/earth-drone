// Two flight models on the WGS84 globe, toggled with V:
//
// "heli" (default) — Battlefield little-bird style. The mouse is the cyclic:
// it tilts the airframe (pitch/roll). W/S is collective, A/D is rudder.
// Lift acts along the airframe's up axis and gravity always pulls, so all
// horizontal motion comes from tilting — nose down to accelerate, bank to
// slide, bank + speed carves a coordinated turn. Attitude holds where you
// put it (full barrel rolls); a gentle hover assist self-rights the
// airframe only near level, like BF's arcade feel.
//
// "fpv" — fly-where-you-look drone: mouse aims, W thrusts along the view.
//
// All smoothing uses exponential decay so the feel is frame-rate independent.

const { Cartesian3, Cartesian4, Cartographic, Matrix4, Transforms } = Cesium;
const CesiumMath = Cesium.Math; // exported as `Math` on the global Cesium build

const G = 9.8;

const HELI = {
  rollSens: 0.0032,   // rad of bank per px of mouse X
  pitchSens: 0.0024,  // rad of pitch per px of mouse Y (mouse up = nose down)
  rollRateMax: 3.4,   // rad/s — little-bird snap rolls
  pitchRateMax: 2.3,  // rad/s
  rotSmooth: 11,      // 1/s cyclic response; lower = heavier airframe
  // HPR can't represent pitch past vertical, so loops stop just short;
  // roll is unrestricted (full barrel rolls).
  pitchLimit: CesiumMath.toRadians(88),
  yawRateMax: CesiumMath.toRadians(90), // rudder, rad/s at hover
  yawSpeedFade: 0.5,    // fraction of tail authority lost at top speed
  yawSmooth: 5.0,       // 1/s rudder response
  // Hover assist: self-rights only near level, fading to nothing by
  // autoLevelTilt — a held bank stays held, like BF.
  autoLevel: 0.6,       // 1/s
  autoLevelTilt: CesiumMath.toRadians(26),
  // Arcade BF steering: velocity chases a target set by attitude. Tilt the
  // nose to set speed, level out to bleed it off — no realistic lift loss.
  maxFwd: 82,           // m/s at full nose-down (~295 km/h)
  maxLat: 26,           // m/s full-bank slide
  climbRate: 16,        // m/s at full collective up
  sinkRate: 24,         // m/s at full collective down
  diveCouple: 0.65,     // how much of a steep nose-down becomes descent
  sagTilt: CesiumMath.toRadians(50), // banking past this starts to sink...
  sagRate: 18,          // ...this hard (m/s per radian past the threshold)
  chaseRate: 1.4,       // 1/s velocity convergence — momentum without skating
  accelCap: 30,         // m/s² — little-bird punch, not teleportation
  boostMul: 1.32,       // Shift: more speed, climb, and acceleration
  turnCapRate: CesiumMath.toRadians(70), // max coordinated-turn rate
  fovBase: CesiumMath.toRadians(70),
  fovSpeedKick: CesiumMath.toRadians(12),
};

const FPV = {
  accel: 34,
  vertAccel: 26,
  drag: 1.05,
  maxSpeed: 38,
  maxSpeedBoost: 95,
  maxVert: 18,
  maxVertBoost: 38,
  pitchLimit: CesiumMath.toRadians(88),
  bankFromYaw: 0.42,
  bankFromStrafe: 0.30,
  bankMax: CesiumMath.toRadians(38),
  bankSmooth: 6.0,
  leanMax: CesiumMath.toRadians(7),
  leanSmooth: 4.0,
  fovBase: CesiumMath.toRadians(75),
  fovBoost: CesiumMath.toRadians(86),
  fovSmooth: 5.0,
};

const GROUND_CLEARANCE = 1.8; // m above sampled surface

const scratchEnu = new Matrix4();
const scratchCol = new Cartesian4();
const scratchE = new Cartesian3();
const scratchN = new Cartesian3();
const scratchU = new Cartesian3();
const scratchFwd = new Cartesian3();
const scratchRight = new Cartesian3();
const scratchBodyUp = new Cartesian3();
const scratchA = new Cartesian3();
const scratchB = new Cartesian3();
const scratchCarto = new Cartographic();

function smooth(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

export class Drone {
  constructor(scene, controls) {
    this.scene = scene;
    this.camera = scene.camera;
    this.controls = controls;

    this.mode = "heli";
    this.position = new Cartesian3();
    this.velocity = new Cartesian3(0, 0, 0);
    this.heading = 0;
    this.pitch = 0;          // airframe pitch (heli) / look pitch (fpv)
    this.roll = 0;           // airframe bank (heli) / visual bank (fpv)
    this.lean = 0;           // fpv-only visual lean
    this.yawRate = 0;        // smoothed: heli rudder / fpv banking
    this.rollRate = 0;       // heli-only smoothed body rates
    this.pitchRate = 0;
    this.fov = HELI.fovBase;
    this.throttle = 0;       // 0..1 smoothed, for audio
    this.wobbleT = 0;

    this.groundHeight = undefined; // last sampled surface height (MSL, m)
    this.canSample = scene.sampleHeightSupported;
    this.sampleTimer = 0; // sampleHeight is an expensive pick — throttle it
    this.lastGood = new Cartesian3(); // recovery point for the NaN watchdog
  }

  toggleMode() {
    this.mode = this.mode === "heli" ? "fpv" : "heli";
    this.yawRate = 0;  // the two models reuse the rate state differently
    this.rollRate = 0;
    this.pitchRate = 0;
    return this.mode;
  }

  setPose(lon, lat, height, headingDeg, pitchDeg) {
    Cartesian3.fromDegrees(lon, lat, height, undefined, this.position);
    this.heading = CesiumMath.toRadians(headingDeg);
    this.pitch = this.mode === "heli" ? 0 : CesiumMath.toRadians(pitchDeg);
    this.roll = 0;
    this.lean = 0;
    this.yawRate = 0;
    this.rollRate = 0;
    this.pitchRate = 0;
    this.groundHeight = undefined; // stale ground from the old location
    this.sampleTimer = 0;
    Cartesian3.clone(Cartesian3.ZERO, this.velocity);
    Cartesian3.clone(this.position, this.lastGood);
    this.applyCamera();
  }

  // Build the local ENU basis and the heading-relative horizontal axes.
  computeFrame() {
    Transforms.eastNorthUpToFixedFrame(this.position, undefined, scratchEnu);
    Cartesian3.fromCartesian4(Matrix4.getColumn(scratchEnu, 0, scratchCol), scratchE);
    Cartesian3.fromCartesian4(Matrix4.getColumn(scratchEnu, 1, scratchCol), scratchN);
    Cartesian3.fromCartesian4(Matrix4.getColumn(scratchEnu, 2, scratchCol), scratchU);

    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    // forward = north*cosH + east*sinH ; right = east*cosH - north*sinH
    Cartesian3.multiplyByScalar(scratchN, cosH, scratchFwd);
    Cartesian3.multiplyByScalar(scratchE, sinH, scratchA);
    Cartesian3.add(scratchFwd, scratchA, scratchFwd);

    Cartesian3.multiplyByScalar(scratchE, cosH, scratchRight);
    Cartesian3.multiplyByScalar(scratchN, -sinH, scratchA);
    Cartesian3.add(scratchRight, scratchA, scratchRight);
  }

  update(dt) {
    dt = Math.min(dt, 0.05); // never integrate across a long stall

    // NaN watchdog: one bad input (mouse glitch, degenerate frame) must
    // never poison the simulation permanently — reset only the offending
    // state and keep flying.
    if (!Number.isFinite(this.heading + this.pitch + this.roll + this.fov
        + this.rollRate + this.pitchRate + this.yawRate + this.throttle)) {
      console.warn("[EarthDrone] non-finite attitude state — recovering");
      if (!Number.isFinite(this.heading)) this.heading = 0;
      this.pitch = 0; this.roll = 0; this.lean = 0;
      this.rollRate = 0; this.pitchRate = 0; this.yawRate = 0;
      this.fov = HELI.fovBase;
      this.throttle = 0.3;
    }
    if (!Number.isFinite(this.velocity.x + this.velocity.y + this.velocity.z)) {
      Cartesian3.clone(Cartesian3.ZERO, this.velocity);
    }
    if (!Number.isFinite(this.position.x + this.position.y + this.position.z)) {
      Cartesian3.clone(this.lastGood, this.position);
    }

    const boost = this.mode === "heli" ? this.updateHeli(dt) : this.updateFpv(dt);

    // --- Integrate position ---
    Cartesian3.multiplyByScalar(this.velocity, dt, scratchA);
    Cartesian3.add(this.position, scratchA, this.position);

    // --- Ground collision against loaded tiles ---
    // sampleHeight does a full intersection pick — doing it every frame
    // tanks the frame rate. Sample on a timer (faster when near the
    // ground), clamp every frame against the cached height.
    Cartographic.fromCartesian(this.position, undefined, scratchCarto);
    this.sampleTimer -= dt;
    if (this.canSample && this.sampleTimer <= 0) {
      const agl = this.groundHeight !== undefined
        ? scratchCarto.height - this.groundHeight : Infinity;
      this.sampleTimer = agl < 50 ? 0.06 : 0.3;
      let h;
      try { h = this.scene.sampleHeight(scratchCarto); } catch (e) { h = undefined; }
      if (h !== undefined) this.groundHeight = h;
    }
    if (this.groundHeight !== undefined) {
      const minH = this.groundHeight + GROUND_CLEARANCE;
      if (scratchCarto.height < minH) {
        scratchCarto.height = minH;
        Cartesian3.fromRadians(
          scratchCarto.longitude, scratchCarto.latitude, scratchCarto.height,
          undefined, this.position);
        // Kill the into-ground velocity component, keep the slide.
        const vU = Cartesian3.dot(this.velocity, scratchU);
        if (vU < 0) {
          Cartesian3.multiplyByScalar(scratchU, vU, scratchB);
          Cartesian3.subtract(this.velocity, scratchB, this.velocity);
        }
      }
    }
    // Absolute floor while tiles are still streaming in.
    if (scratchCarto.height < -420) {
      scratchCarto.height = -420;
      Cartesian3.fromRadians(
        scratchCarto.longitude, scratchCarto.latitude, scratchCarto.height,
        undefined, this.position);
    }

    // --- Shared visuals + state ---
    const speed = Cartesian3.magnitude(this.velocity);
    const vUp = Cartesian3.dot(this.velocity, scratchU);
    const hSpeed = Math.sqrt(Math.max(0, speed * speed - vUp * vUp));

    this.wobbleT += dt;
    const calm = Math.max(0, 1 - speed / 12); // wobble fades with airspeed
    const wobR = Math.sin(this.wobbleT * 2.1) * 0.0035 * calm
               + Math.sin(this.wobbleT * 5.7 + 1.3) * 0.0015 * calm;
    const wobP = Math.sin(this.wobbleT * 1.7 + 0.6) * 0.0025 * calm;

    if (Number.isFinite(this.position.x + this.position.y + this.position.z)) {
      Cartesian3.clone(this.position, this.lastGood);
    }

    this.applyCamera(wobP, wobR);

    return {
      speed,
      hSpeed,
      heightMSL: scratchCarto.height,
      heightAGL: this.groundHeight !== undefined
        ? scratchCarto.height - this.groundHeight : undefined,
      lon: CesiumMath.toDegrees(scratchCarto.longitude),
      lat: CesiumMath.toDegrees(scratchCarto.latitude),
      heading: this.heading,
      boost,
      throttle: this.throttle,
      speedFrac: Math.min(1, speed / 95),
      mode: this.mode,
    };
  }

  // --- Battlefield little-bird model ---
  updateHeli(dt) {
    const c = this.controls;
    const { dx, dy } = c.consumeMouse();
    const speed0 = Cartesian3.magnitude(this.velocity);

    // Cyclic: mouse right = bank right, mouse up = nose down. The mouse
    // commands body *rates* (capped at little-bird agility), lightly
    // smoothed so the airframe has inertia instead of teleporting.
    let cmdRoll = 0, cmdPitch = 0;
    if (c.locked && dt > 0) {
      cmdRoll = CesiumMath.clamp(
        (dx * HELI.rollSens) / dt, -HELI.rollRateMax, HELI.rollRateMax);
      cmdPitch = CesiumMath.clamp(
        (dy * HELI.pitchSens) / dt, -HELI.pitchRateMax, HELI.pitchRateMax);
    }
    this.rollRate += (cmdRoll - this.rollRate) * smooth(HELI.rotSmooth, dt);
    this.pitchRate += (cmdPitch - this.pitchRate) * smooth(HELI.rotSmooth, dt);
    this.roll = CesiumMath.negativePiToPi(this.roll + this.rollRate * dt);
    this.pitch = CesiumMath.clamp(
      this.pitch + this.pitchRate * dt, -HELI.pitchLimit, HELI.pitchLimit);

    const ax = c.locked ? c.axes
      : { collective: 0, yaw: 0, boost: false };

    // Rudder: tail authority ramps in and fades with airspeed.
    const yawTarget = ax.yaw * HELI.yawRateMax
      * (1 - HELI.yawSpeedFade * Math.min(1, speed0 / 80));
    this.yawRate += (yawTarget - this.yawRate) * smooth(HELI.yawSmooth, dt);
    this.heading = CesiumMath.zeroToTwoPi(this.heading + this.yawRate * dt);

    this.computeFrame();

    // Coordinated turn: with forward speed, bank curves the flight path
    // (rate = g·tan(bank)/v, like a real aircraft). Only while the rotor
    // points skyward — knife-edge or inverted you just fall.
    const fwdSpeed = Cartesian3.dot(this.velocity, scratchFwd);
    if (fwdSpeed > 4 && Math.abs(this.roll) < CesiumMath.toRadians(75)) {
      const turn = CesiumMath.clamp(
        Math.tan(this.roll) * G / Math.max(fwdSpeed, 10),
        -HELI.turnCapRate, HELI.turnCapRate);
      this.heading = CesiumMath.zeroToTwoPi(this.heading + turn * dt);
    }

    // Hover assist: self-right only near level so a held bank stays held.
    // tilt = angle between the rotor axis and straight up.
    const tilt = Math.acos(CesiumMath.clamp(
      Math.cos(this.pitch) * Math.cos(this.roll), -1, 1));
    const levelFade = Math.max(0, 1 - tilt / HELI.autoLevelTilt);
    if (levelFade > 0) {
      const settle = smooth(HELI.autoLevel, dt) * levelFade;
      this.roll -= this.roll * settle;
      this.pitch -= this.pitch * settle;
    }

    // --- Arcade BF steering ---
    // Velocity chases a target read straight off the attitude: nose down
    // = forward speed, bank = lateral slide, collective = climb/sink.
    // Gravity shows up where it feels right — steep dives pull you down,
    // hard banks sag, chopping collective drops you — never as a constant
    // realistic force fighting the player.
    const boost = ax.boost;
    const boostMul = boost ? HELI.boostMul : 1;
    const sinP = Math.sin(this.pitch);

    const fwdCmd = -sinP * HELI.maxFwd * boostMul;          // nose down = go
    const latCmd = Math.sin(this.roll) * HELI.maxLat * boostMul;
    const dive = Math.max(0, fwdCmd) * sinP * HELI.diveCouple; // steep nose = descend
    const sag = -Math.max(0, tilt - HELI.sagTilt) * HELI.sagRate;
    const climb = ax.collective * boostMul
      * (ax.collective > 0 ? HELI.climbRate : HELI.sinkRate);

    // target velocity = fwd*fwdCmd + right*latCmd + up*(climb + dive + sag)
    Cartesian3.multiplyByScalar(scratchFwd, fwdCmd, scratchB);
    Cartesian3.multiplyByScalar(scratchRight, latCmd, scratchA);
    Cartesian3.add(scratchB, scratchA, scratchB);
    Cartesian3.multiplyByScalar(scratchU, climb + dive + sag, scratchA);
    Cartesian3.add(scratchB, scratchA, scratchB);

    // Chase it with capped acceleration: momentum without ice-skating.
    Cartesian3.subtract(scratchB, this.velocity, scratchA);
    const dvMag = Cartesian3.magnitude(scratchA);
    let blend = smooth(HELI.chaseRate, dt);
    const maxDv = HELI.accelCap * boostMul * dt;
    if (dvMag * blend > maxDv && dvMag > 0) blend = maxDv / dvMag;
    Cartesian3.multiplyByScalar(scratchA, blend, scratchA);
    Cartesian3.add(this.velocity, scratchA, this.velocity);

    // FOV widens with airspeed.
    const speed = Cartesian3.magnitude(this.velocity);
    const targetFov = HELI.fovBase + HELI.fovSpeedKick * Math.min(1, speed / 80);
    this.fov += (targetFov - this.fov) * smooth(4, dt);

    const targetThrottle = 0.34 + Math.max(0, ax.collective) * 0.45
      + Math.abs(this.pitch) * 0.25 + (boost ? 0.2 : 0);
    this.throttle += (Math.min(1, targetThrottle) - this.throttle) * smooth(3, dt);

    return boost;
  }

  // --- Fly-where-you-look drone model (the original) ---
  updateFpv(dt) {
    const c = this.controls;
    const { dx, dy } = c.consumeMouse();

    if (c.locked) {
      this.heading = CesiumMath.zeroToTwoPi(this.heading + dx * c.sensitivity);
      this.pitch = CesiumMath.clamp(
        this.pitch - dy * c.sensitivity, -FPV.pitchLimit, FPV.pitchLimit);
    }
    const instYaw = c.locked && dt > 0 ? (dx * c.sensitivity) / dt : 0;
    this.yawRate += (instYaw - this.yawRate) * smooth(8, dt);

    this.computeFrame();

    // Tilt forward by pitch so W flies where you look.
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    Cartesian3.multiplyByScalar(scratchFwd, cosP, scratchFwd);
    Cartesian3.multiplyByScalar(scratchU, sinP, scratchA);
    Cartesian3.add(scratchFwd, scratchA, scratchFwd);

    const ax = c.locked ? c.axes
      : { forward: 0, strafe: 0, vertical: 0, boost: false };
    const boost = ax.boost && (ax.forward !== 0 || ax.strafe !== 0 || ax.vertical !== 0);
    const accelScale = boost ? 2.4 : 1;

    Cartesian3.multiplyByScalar(scratchFwd, ax.forward * FPV.accel * accelScale, scratchA);
    Cartesian3.multiplyByScalar(scratchRight, ax.strafe * FPV.accel * 0.8 * accelScale, scratchB);
    Cartesian3.add(scratchA, scratchB, scratchA);
    Cartesian3.multiplyByScalar(scratchU, ax.vertical * FPV.vertAccel * (boost ? 1.8 : 1), scratchB);
    Cartesian3.add(scratchA, scratchB, scratchA);

    Cartesian3.multiplyByScalar(scratchA, dt, scratchA);
    Cartesian3.add(this.velocity, scratchA, this.velocity);

    const dragFactor = Math.exp(-FPV.drag * dt);
    Cartesian3.multiplyByScalar(this.velocity, dragFactor, this.velocity);

    const vUp = Cartesian3.dot(this.velocity, scratchU);
    Cartesian3.multiplyByScalar(scratchU, vUp, scratchB);     // vertical part
    Cartesian3.subtract(this.velocity, scratchB, scratchA);   // horizontal part

    const maxH = boost ? FPV.maxSpeedBoost : FPV.maxSpeed;
    const maxV = boost ? FPV.maxVertBoost : FPV.maxVert;
    const hSpeed = Cartesian3.magnitude(scratchA);
    if (hSpeed > maxH) Cartesian3.multiplyByScalar(scratchA, maxH / hSpeed, scratchA);
    const vClamped = CesiumMath.clamp(vUp, -maxV * 1.6, maxV);
    Cartesian3.multiplyByScalar(scratchU, vClamped, scratchB);
    Cartesian3.add(scratchA, scratchB, this.velocity);

    // Visual bank, lean, FOV.
    const targetRoll = CesiumMath.clamp(
      this.yawRate * FPV.bankFromYaw + ax.strafe * FPV.bankFromStrafe,
      -FPV.bankMax, FPV.bankMax);
    this.roll += (targetRoll - this.roll) * smooth(FPV.bankSmooth, dt);

    const targetLean = ax.forward * FPV.leanMax * (boost ? 1.0 : 0.55);
    this.lean += (targetLean - this.lean) * smooth(FPV.leanSmooth, dt);

    const targetFov = boost ? FPV.fovBoost : FPV.fovBase;
    this.fov += (targetFov - this.fov) * smooth(FPV.fovSmooth, dt);

    const inputMag = Math.min(1,
      Math.abs(ax.forward) + Math.abs(ax.strafe) * 0.7 + Math.abs(ax.vertical) * 0.9);
    const targetThrottle = 0.32 + inputMag * (boost ? 0.68 : 0.42);
    this.throttle += (targetThrottle - this.throttle) * smooth(3, dt);

    return boost;
  }

  applyCamera(wobP = 0, wobR = 0) {
    const visualPitch = this.mode === "heli"
      ? this.pitch + wobP
      : this.pitch - this.lean + wobP;
    this.camera.setView({
      destination: this.position,
      orientation: {
        heading: this.heading,
        pitch: visualPitch,
        roll: this.roll + wobR,
      },
    });
    if (this.camera.frustum.fov !== undefined) {
      this.camera.frustum.fov = this.fov;
    }
  }
}
