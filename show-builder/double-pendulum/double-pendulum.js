#!/usr/bin/env node
/**
 * double-pendulum.js — Gothic Folly generative light show
 *
 * A chaotic double pendulum (the classic p5.js sketch) swinging through the
 * whole cathedral. The pendulum lives on the front facade plane:
 *     horizontal = z_norm  (0 = left, 1 = right)
 *     vertical   = y_norm  (0 = ground, 1 = top of spires)
 * It pivots from the top-center and hangs down. Every LED near the two
 * swinging arms lights up, and a decaying "phosphor" trail paints the path
 * the lower bob sweeps — a slow rainbow that fades behind the motion.
 *
 * Because the projection ignores depth (x_norm), the pendulum reads as a
 * glowing curtain swinging through the full 3D structure: front arches,
 * mini arches, quad arches, spires, canopy and orbs all participate at once.
 *
 * Data flow (identical to TouchDesigner / the playa F48V5):
 *     this script ──sACN/E1.31 UDP :5568──▶ relay.js ──WebSocket :3001──▶ cathedral-3d-sim.html
 *
 * Usage:
 *     node relay/relay.js                       # in one terminal
 *     python3 -m http.server 8765               # in another (from show-builder/)
 *     open http://localhost:8765/cathedral-3d-sim.html
 *     node double-pendulum/double-pendulum.js   # in a third — lights it up
 *
 * No npm install needed: pure Node (dgram + fs), zero dependencies.
 * Tune the CONFIG block below to change physics, colors and feel.
 */

'use strict';

const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  // Network — where the relay (or, on playa, the F48V5) is listening.
  host: '127.0.0.1',
  port: 5568,
  fps:  40,

  // Pendulum geometry, in normalized facade units (0..1 across the cathedral).
  // The pivot sits high-center and the two arms (L1+L2 ≈ 0.56) keep the swing
  // disk inside the facade so the bobs stay on real LEDs as they go chaotic.
  pivot:   { z: 0.5, y: 0.6 },  // high-center; pendulum hangs and swings below
  L1:      0.30,                // upper arm length
  L2:      0.26,                // lower arm length
  m1:      1.0,                 // upper bob mass
  m2:      1.4,                 // lower bob mass (heavier = livelier chaos)
  g:       9.8,                 // gravity
  damping: 0.0,                 // 0 = frictionless (stays chaotic forever)
  substeps: 8,                  // physics steps per frame (higher = more stable)

  // Initial state — small differences here lead to wildly different shows.
  theta1_0: Math.PI * 0.62,     // upper angle from straight-down (radians)
  theta2_0: Math.PI * 0.55,     // lower angle from straight-down

  // Look & feel.
  armWidth:    0.045,  // how close a pixel must be to an arm to light (Gaussian sigma)
  bobSize:     0.075,  // glow radius of the two bobs
  trailDecay:  0.90,   // per-frame fade of the phosphor trail (0..1; higher = longer trail)
  hueSpeed:    35,     // degrees/sec the trail rainbow drifts
  upperArmHue: 200,    // hue of the upper arm (cool cyan-blue)
  brightness:  1.0,    // master output scale (0..1)
  gamma:       2.2,    // perceptual gamma for nicer low-end fade
};

const HERE     = __dirname;
const CSV_PATH = path.join(HERE, '..', 'td', 'all-pixels-positions.csv');

// ── Load pixel geometry ───────────────────────────────────────────────────────
// CSV columns: zone,pixel_id,universe,channel,cat_x,cat_y,cat_z,x_norm,y_norm,z_norm
// `channel` is the 1-based DMX start channel of the pixel within its universe.
function loadPixels(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const header = lines[0].split(',').map(s => s.trim());  // CRLF-safe header
  const col = name => header.indexOf(name);
  const cU = col('universe'), cCh = col('channel');
  const cY = col('y_norm'), cZ = col('z_norm');

  const pixels = [];
  const universes = new Set();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const universe = parseInt(f[cU], 10);
    const ch0 = parseInt(f[cCh], 10) - 1;  // → 0-based byte offset into DMX data
    pixels.push({
      universe,
      ch0,
      z: parseFloat(f[cZ]),  // horizontal on the facade
      y: parseFloat(f[cY]),  // vertical on the facade
    });
    universes.add(universe);
  }
  return { pixels, universes: [...universes].sort((a, b) => a - b) };
}

const { pixels, universes } = loadPixels(CSV_PATH);
console.log(`Loaded ${pixels.length} pixels across universes ${universes[0]}–${universes[universes.length - 1]}`);

// Per-pixel phosphor accumulator (linear RGB, 0..1+, decays each frame).
const acc = new Float32Array(pixels.length * 3);

// ── Double pendulum physics (RK4 on the standard Lagrangian equations) ─────────
// State = [theta1, omega1, theta2, omega2], angles measured from straight-down.
let state = [CONFIG.theta1_0, 0, CONFIG.theta2_0, 0];

function derivs(s) {
  const { L1, L2, m1, m2, g, damping } = CONFIG;
  const [t1, w1, t2, w2] = s;
  const dt = t1 - t2;
  const cs = Math.cos(dt), sn = Math.sin(dt);
  const den = 2 * m1 + m2 - m2 * Math.cos(2 * t1 - 2 * t2);

  const a1 = (-g * (2 * m1 + m2) * Math.sin(t1)
              - m2 * g * Math.sin(t1 - 2 * t2)
              - 2 * sn * m2 * (w2 * w2 * L2 + w1 * w1 * L1 * cs))
             / (L1 * den) - damping * w1;

  const a2 = (2 * sn * (w1 * w1 * L1 * (m1 + m2)
              + g * (m1 + m2) * Math.cos(t1)
              + w2 * w2 * L2 * m2 * cs))
             / (L2 * den) - damping * w2;

  return [w1, a1, w2, a2];
}

function rk4Step(s, h) {
  const add = (a, b, sc) => a.map((v, i) => v + b[i] * sc);
  const k1 = derivs(s);
  const k2 = derivs(add(s, k1, h / 2));
  const k3 = derivs(add(s, k2, h / 2));
  const k4 = derivs(add(s, k3, h));
  return s.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

// Current pivot/bob positions on the (z, y) facade plane.
function bobPositions() {
  const { pivot, L1, L2 } = CONFIG;
  const [t1, , t2] = state;
  const P0 = { z: pivot.z, y: pivot.y };
  const P1 = { z: P0.z + L1 * Math.sin(t1), y: P0.y - L1 * Math.cos(t1) };
  const P2 = { z: P1.z + L2 * Math.sin(t2), y: P1.y - L2 * Math.cos(t2) };
  return { P0, P1, P2 };
}

// ── Geometry & color helpers ───────────────────────────────────────────────────
// Squared distance from point p to segment ab, in facade space.
function distSqToSeg(pz, py, az, ay, bz, by) {
  const dz = bz - az, dy = by - ay;
  const len2 = dz * dz + dy * dy;
  let t = len2 > 0 ? ((pz - az) * dz + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cz = az + t * dz, cy = ay + t * dy;
  const ez = pz - cz, ey = py - cy;
  return ez * ez + ey * ey;
}

// HSV (h in deg, s/v in 0..1) → linear-ish RGB 0..1.
function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 1)      { r = c; g = x; }
  else if (h < 2) { r = x; g = c; }
  else if (h < 3) { g = c; b = x; }
  else if (h < 4) { g = x; b = c; }
  else if (h < 5) { r = x; b = c; }
  else            { r = c; b = x; }
  return [r + m, g + m, b + m];
}

// ── sACN / E1.31 packet builder ────────────────────────────────────────────────
const CHANNELS = 510;  // full universe, zero-padded
const CID = Buffer.from([
  0x47, 0x6f, 0x74, 0x68, 0x69, 0x63, 0x46, 0x6f,  // "GothicFolly-DP01"
  0x6c, 0x6c, 0x79, 0x2d, 0x44, 0x50, 0x30, 0x31,
]);
const SOURCE_NAME = 'Gothic Folly Double Pendulum';
let seq = 0;

// Build a complete, valid E1.31 packet for `universe` carrying `data` (Uint8Array).
function buildPacket(universe, data) {
  const propCount = data.length + 1;        // + DMX start code
  const buf = Buffer.alloc(126 + data.length);

  // Root layer
  buf.writeUInt16BE(0x0010, 0);             // preamble size
  buf.writeUInt16BE(0x0000, 2);             // postamble size
  buf.write('ASC-E1.17\0\0\0', 4, 'binary');// ACN packet identifier
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16);  // flags + length
  buf.writeUInt32BE(0x00000004, 18);        // root vector
  CID.copy(buf, 22);

  // Framing layer
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38);  // flags + length
  buf.writeUInt32BE(0x00000002, 40);        // framing vector
  buf.write(SOURCE_NAME, 44, 'utf8');       // source name (64 bytes, zero-padded)
  buf.writeUInt8(100, 108);                 // priority
  buf.writeUInt16BE(0, 109);                // sync universe
  buf.writeUInt8(seq & 0xff, 111);          // sequence number
  buf.writeUInt8(0, 112);                   // options
  buf.writeUInt16BE(universe, 113);         // universe

  // DMP layer
  buf.writeUInt16BE(0x7000 | (buf.length - 115), 115);// flags + length
  buf.writeUInt8(0x02, 117);                // DMP vector
  buf.writeUInt8(0xa1, 118);                // address & data type
  buf.writeUInt16BE(0x0000, 119);           // first property address
  buf.writeUInt16BE(0x0001, 121);           // address increment
  buf.writeUInt16BE(propCount, 123);        // property value count
  buf.writeUInt8(0x00, 125);                // DMX start code
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(buf, 126);

  return buf;
}

// ── Render loop ─────────────────────────────────────────────────────────────────
const socket = dgram.createSocket('udp4');
const dmx = new Map();  // universe → Uint8Array(510)
for (const u of universes) dmx.set(u, new Uint8Array(CHANNELS));

const dt = 1 / CONFIG.fps;
let frame = 0;
const invGamma = 1 / CONFIG.gamma;

function renderFrame() {
  // 1. Advance physics.
  const h = dt / CONFIG.substeps;
  for (let i = 0; i < CONFIG.substeps; i++) state = rk4Step(state, h);
  const { P0, P1, P2 } = bobPositions();

  // 2. Fade the phosphor trail.
  const decay = CONFIG.trailDecay;
  for (let i = 0; i < acc.length; i++) acc[i] *= decay;

  // 3. Paint arms + bobs into the accumulator.
  const t = frame / CONFIG.fps;
  const trailHue = t * CONFIG.hueSpeed;
  const [tr, tg, tb] = hsv2rgb(trailHue, 1.0, 1.0);            // lower arm / sweep — rainbow
  const [ur, ug, ub] = hsv2rgb(CONFIG.upperArmHue, 0.5, 1.0); // upper arm — cool
  const sigA2 = 2 * CONFIG.armWidth * CONFIG.armWidth;
  const sigB2 = 2 * CONFIG.bobSize * CONFIG.bobSize;

  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const o = i * 3;

    // Lower arm (the star of the show) — rainbow trail.
    const dl = distSqToSeg(p.z, p.y, P1.z, P1.y, P2.z, P2.y);
    const gl = Math.exp(-dl / sigA2);
    // Upper arm — cool, structural.
    const du = distSqToSeg(p.z, p.y, P0.z, P0.y, P1.z, P1.y);
    const gu = Math.exp(-du / sigA2) * 0.8;
    // Bobs — bright glowing cores.
    const db1 = (p.z - P1.z) ** 2 + (p.y - P1.y) ** 2;
    const db2 = (p.z - P2.z) ** 2 + (p.y - P2.y) ** 2;
    const gb = Math.exp(-db1 / sigB2) * 0.9 + Math.exp(-db2 / sigB2) * 1.3;

    acc[o]     = Math.max(acc[o],     gl * tr + gu * ur + gb);
    acc[o + 1] = Math.max(acc[o + 1], gl * tg + gu * ug + gb);
    acc[o + 2] = Math.max(acc[o + 2], gl * tb + gu * ub + gb);
  }

  // 4. Accumulator → DMX buffers (gamma + clamp).
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i], o = i * 3;
    const buf = dmx.get(p.universe);
    buf[p.ch0]     = toByte(acc[o]);
    buf[p.ch0 + 1] = toByte(acc[o + 1]);
    buf[p.ch0 + 2] = toByte(acc[o + 2]);
  }

  // 5. Emit one sACN packet per universe.
  for (const u of universes) {
    socket.send(buildPacket(u, dmx.get(u)), CONFIG.port, CONFIG.host);
  }
  seq++;
  frame++;
}

function toByte(v) {
  v = Math.pow(Math.min(1, Math.max(0, v)) * CONFIG.brightness, invGamma);
  return Math.round(v * 255);
}

const timer = setInterval(renderFrame, Math.round(1000 / CONFIG.fps));

console.log(`Streaming double pendulum → sACN ${CONFIG.host}:${CONFIG.port} @ ${CONFIG.fps}fps`);
console.log('Make sure relay.js is running and the simulator is open. Press Ctrl-C to stop.');

// Clean shutdown: blackout all universes, then exit.
process.on('SIGINT', () => {
  clearInterval(timer);
  const black = new Uint8Array(CHANNELS);
  let pending = universes.length;
  if (!pending) process.exit(0);
  for (const u of universes) {
    socket.send(buildPacket(u, black), CONFIG.port, CONFIG.host, () => {
      if (--pending === 0) { socket.close(); console.log('\nBlackout sent. Bye.'); process.exit(0); }
    });
  }
});
