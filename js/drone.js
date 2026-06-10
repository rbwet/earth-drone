// FPV drone flight model on the WGS84 globe.
//
// The drone flies "where you look" (W follows the camera direction), with
// velocity integration, exponential drag, banked turns driven by yaw rate
// and strafe, a forward lean under acceleration, and ground collision
// sampled against the loaded 3D tiles. All smoothing uses exponential
// decay so the feel is identical at any frame rate.

const { Cartesian3, Cartesian4, Cartographic, Matrix4, Transforms } = Cesium;
const CesiumMath = Cesium.Math; // exported as `Math` on the global Cesium build

const TUNE = {
  accel: 34,          // m/s² thrust
  vertAccel: 26,
  drag: 1.05,         // 1/s velocity decay
  maxSpeed: 38,       // m/s cruise (~137 km/h)
  maxSpeedBoost: 95,  // m/s boosted (~342 km/h)
  maxVert: 18,
  maxVertBoost: 38,
  pitchLimit: CesiumMath.toRadians(88),
  bankFromYaw: 0.42,      // roll per rad/s of yaw rate
  bankFromStrafe: 0.30,   // roll per unit strafe input
  bankMax: CesiumMath.toRadians(38),
  bankSmooth: 6.0,        // 1/s
  leanMax: CesiumMath.toRadians(7),
  leanSmooth: 4.0,
  fovBase: CesiumMath.toRadians(75),
  fovBoost: CesiumMath.toRadians(86),
  fovSmooth: 5.0,
  groundClearance: 1.8,   // m above sampled surface
};

const scratchEnu = new Matrix4();
const scratchCol = new Cartesian4();
const scratchE = new Cartesian3();
const scratchN = new Cartesian3();
const scratchU = new Cartesian3();
const scratchFwd = new Cartesian3();
const scratchRight = new Cartesian3();
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

    this.position = new Cartesian3();
    this.velocity = new Cartesian3(0, 0, 0);
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;          // visual bank
    this.lean = 0;          // visual forward lean
    this.yawRate = 0;       // smoothed, for banking
    this.fov = TUNE.fovBase;
    this.throttle = 0;      // 0..1 smoothed, for audio
    this.wobbleT = 0;

    this.groundHeight = undefined; // last sampled surface height (MSL, meters)
    this.canSample = scene.sampleHeightSupported;
    this.sampleTimer = 0; // sampleHeight is an expensive pick — throttle it
  }

  setPose(lon, lat, height, headingDeg, pitchDeg) {
    Cartesian3.fromDegrees(lon, lat, height, undefined, this.position);
    this.heading = CesiumMath.toRadians(headingDeg);
    this.pitch = CesiumMath.toRadians(pitchDeg);
    this.roll = 0;
    this.lean = 0;
    this.groundHeight = undefined; // stale ground from the old location
    this.sampleTimer = 0;
    Cartesian3.clone(Cartesian3.ZERO, this.velocity);
    this.applyCamera();
  }

  update(dt) {
    dt = Math.min(dt, 0.05); // never integrate across a long stall
    const c = this.controls;

    // --- Look ---
    const { dx, dy } = c.consumeMouse();
    if (c.locked) {
      this.heading = CesiumMath.zeroToTwoPi(this.heading + dx * c.sensitivity);
      this.pitch = CesiumMath.clamp(
        this.pitch - dy * c.sensitivity, -TUNE.pitchLimit, TUNE.pitchLimit);
    }
    const instYaw = c.locked && dt > 0 ? (dx * c.sensitivity) / dt : 0;
    this.yawRate += (instYaw - this.yawRate) * smooth(8, dt);

    // --- Local frame ---
    Transforms.eastNorthUpToFixedFrame(this.position, undefined, scratchEnu);
    Cartesian3.fromCartesian4(Matrix4.getColumn(scratchEnu, 0, scratchCol), scratchE);
    Cartesian3.fromCartesian4(Matrix4.getColumn(scratchEnu, 1, scratchCol), scratchN);
    Cartesian3.fromCartesian4(Matrix4.getColumn(scratchEnu, 2, scratchCol), scratchU);

    const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
    // Horizontal forward = north*cosH + east*sinH ; right = east*cosH - north*sinH
    Cartesian3.multiplyByScalar(scratchN, cosH, scratchFwd);
    Cartesian3.multiplyByScalar(scratchE, sinH, scratchA);
    Cartesian3.add(scratchFwd, scratchA, scratchFwd);

    Cartesian3.multiplyByScalar(scratchE, cosH, scratchRight);
    Cartesian3.multiplyByScalar(scratchN, -sinH, scratchA);
    Cartesian3.add(scratchRight, scratchA, scratchRight);

    // Tilt forward by pitch so W flies where you look.
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    Cartesian3.multiplyByScalar(scratchFwd, cosP, scratchFwd);
    Cartesian3.multiplyByScalar(scratchU, sinP, scratchA);
    Cartesian3.add(scratchFwd, scratchA, scratchFwd);

    // --- Thrust ---
    const ax = c.locked ? c.axes : { forward: 0, strafe: 0, vertical: 0, boost: false };
    const boost = ax.boost && (ax.forward !== 0 || ax.strafe !== 0 || ax.vertical !== 0);
    const accelScale = boost ? 2.4 : 1;

    Cartesian3.multiplyByScalar(scratchFwd, ax.forward * TUNE.accel * accelScale, scratchA);
    Cartesian3.multiplyByScalar(scratchRight, ax.strafe * TUNE.accel * 0.8 * accelScale, scratchB);
    Cartesian3.add(scratchA, scratchB, scratchA);
    Cartesian3.multiplyByScalar(scratchU, ax.vertical * TUNE.vertAccel * (boost ? 1.8 : 1), scratchB);
    Cartesian3.add(scratchA, scratchB, scratchA);

    Cartesian3.multiplyByScalar(scratchA, dt, scratchA);
    Cartesian3.add(this.velocity, scratchA, this.velocity);

    // --- Drag + speed limits ---
    const dragFactor = Math.exp(-TUNE.drag * dt);
    Cartesian3.multiplyByScalar(this.velocity, dragFactor, this.velocity);

    const vUp = Cartesian3.dot(this.velocity, scratchU);
    Cartesian3.multiplyByScalar(scratchU, vUp, scratchB);     // vertical part
    Cartesian3.subtract(this.velocity, scratchB, scratchA);   // horizontal part

    const maxH = boost ? TUNE.maxSpeedBoost : TUNE.maxSpeed;
    const maxV = boost ? TUNE.maxVertBoost : TUNE.maxVert;
    const hSpeed = Cartesian3.magnitude(scratchA);
    if (hSpeed > maxH) Cartesian3.multiplyByScalar(scratchA, maxH / hSpeed, scratchA);
    const vClamped = CesiumMath.clamp(vUp, -maxV * 1.6, maxV);
    Cartesian3.multiplyByScalar(scratchU, vClamped, scratchB);
    Cartesian3.add(scratchA, scratchB, this.velocity);

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
      const minH = this.groundHeight + TUNE.groundClearance;
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

    // --- Visual bank, lean, FOV, hover wobble ---
    const targetRoll = CesiumMath.clamp(
      this.yawRate * TUNE.bankFromYaw + ax.strafe * TUNE.bankFromStrafe,
      -TUNE.bankMax, TUNE.bankMax);
    this.roll += (targetRoll - this.roll) * smooth(TUNE.bankSmooth, dt);

    const targetLean = ax.forward * TUNE.leanMax * (boost ? 1.0 : 0.55);
    this.lean += (targetLean - this.lean) * smooth(TUNE.leanSmooth, dt);

    const targetFov = boost ? TUNE.fovBoost : TUNE.fovBase;
    this.fov += (targetFov - this.fov) * smooth(TUNE.fovSmooth, dt);

    const speed = Cartesian3.magnitude(this.velocity);
    this.wobbleT += dt;
    const calm = Math.max(0, 1 - speed / 12); // wobble fades with airspeed
    const wobR = Math.sin(this.wobbleT * 2.1) * 0.0035 * calm
               + Math.sin(this.wobbleT * 5.7 + 1.3) * 0.0015 * calm;
    const wobP = Math.sin(this.wobbleT * 1.7 + 0.6) * 0.0025 * calm;

    const inputMag = Math.min(1,
      Math.abs(ax.forward) + Math.abs(ax.strafe) * 0.7 + Math.abs(ax.vertical) * 0.9);
    const targetThrottle = 0.32 + inputMag * (boost ? 0.68 : 0.42);
    this.throttle += (targetThrottle - this.throttle) * smooth(3, dt);

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
      speedFrac: Math.min(1, speed / TUNE.maxSpeedBoost),
    };
  }

  applyCamera(wobP = 0, wobR = 0) {
    this.camera.setView({
      destination: this.position,
      orientation: {
        heading: this.heading,
        pitch: this.pitch - this.lean + wobP,
        roll: this.roll + wobR,
      },
    });
    if (this.camera.frustum.fov !== undefined) {
      this.camera.frustum.fov = this.fov;
    }
  }
}
