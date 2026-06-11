#!/usr/bin/env node
/**
 * arches-pendulum.js — Gothic Folly: pendulum-swept arches
 *
 * A slow double pendulum (the Coding Train p5 sketch's physics) acts as a
 * cursor that sweeps along the arches, turning LEDs on one-by-one as it goes.
 *
 * Lit zones (everything else is held dark):
 *     main arch        universes 17–21   (703 px)
 *     mini arches L/R   universes 22–31  (822 px)
 *     orbs              universe 48        (20 px)
 *
 * Mapping
 *   • The pendulum's lower bob swings left↔right. That horizontal position
 *     becomes a cursor `uc` ∈ [0,1].
 *   • Each arch LED has an arc position `u` ∈ [0,1] along its strip
 *     (u=0 left-leg base → u=0.5 crown → u=1 right-leg base). Orbs map `u`
 *     by their left↔right position. The cursor lights the LEDs it passes.
 *   • Because the arch rises to a crown, the lit point climbs and drops as
 *     the pendulum swings — you see the rise and fall of each swing.
 *
 * Color
 *   • Hue = a slowly-drifting base (cycles the full spectrum over time)
 *     + a vertical gradient by LED height, so taller LEDs read warmer/cooler.
 *   • LEDs fade slowly (phosphor persistence). New swings draw bright over
 *     the top, leaving a pattern of older, faded colors behind.
 *
 * Data flow (identical to TouchDesigner / the playa F48V5):
 *     this script ──sACN/E1.31 UDP :5568──▶ relay.js ──WebSocket :3001──▶ cathedral-3d-sim.html
 *
 * Usage:
 *     node relay/relay.js                          # terminal 1
 *     python3 -m http.server 8766                  # terminal 2 (from show-builder/)
 *     open http://localhost:8766/cathedral-3d-sim.html
 *     node double-pendulum/arches-pendulum.js      # terminal 3
 *
 * Pure Node (dgram + fs), zero dependencies. Tune CONFIG below.
 */

'use strict';

const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  host: '127.0.0.1',
  port: 5568,
  fps:  40,

  // Which zones to light (CSV `zone` values).
  zones: ['main-arch', 'mini-arch-left', 'mini-arch-right', 'orb'],

  // Pendulum — slowed down for a graceful swing.
  pivot:   { z: 0.5, y: 0.6 },
  L1:      0.30,
  L2:      0.26,
  m1:      1.0,
  m2:      1.0,
  g:       9.8,
  damping: 0.0,
  speed:   0.4,          // <1 slows the whole simulation (time scale)
  substeps: 10,
  theta1_0: Math.PI * 0.56,
  theta2_0: Math.PI * 0.50,

  // Look & feel.
  bandWidth:    0.03,    // cursor width in arc units (smaller = more "one-by-one")
  depthRippleSec: 0.8,   // seconds for a swing to travel front→back through the arches
  trailDecay:   0.94,    // per-frame fade (higher = longer-lived faded pattern)
  hueCycleSec:  50,      // seconds for the base hue to traverse the full spectrum
  heightSpread: 130,     // degrees of hue gradient from bottom to top of the scene
  saturation:   1.0,
  brightness:   1.0,
  gamma:        2.2,
};

const HERE     = __dirname;
const CSV_PATH = path.join(HERE, '..', 'td', 'all-pixels-positions.csv');

// ── Load pixel geometry ───────────────────────────────────────────────────────
// CSV columns: zone,pixel_id,universe,channel,cat_x,cat_y,cat_z,x_norm,y_norm,z_norm
function loadPixels(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const header = lines[0].split(',').map(s => s.trim());  // CRLF-safe
  const ci = name => header.indexOf(name);
  const cZone = ci('zone'), cU = ci('universe'), cCh = ci('channel');
  const cX = ci('x_norm'), cY = ci('y_norm'), cZ = ci('z_norm');

  const all = [];
  const universes = new Set();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const universe = parseInt(f[cU], 10);
    universes.add(universe);
    all.push({
      zone: f[cZone],
      universe,
      ch0:  parseInt(f[cCh], 10) - 1,  // 0-based DMX offset
      xNorm: parseFloat(f[cX]),        // global depth 0=front .. 1=back
      yNorm: parseFloat(f[cY]),        // global height 0..1
      zNorm: parseFloat(f[cZ]),        // global left..right 0..1
    });
  }
  return { all, universes: [...universes].sort((a, b) => a - b) };
}

const { all, universes } = loadPixels(CSV_PATH);

// Keep only the LEDs we want to light; assign each an arc parameter `u` ∈ [0,1].
const targetZones = new Set(CONFIG.zones);
const targets = all.filter(p => targetZones.has(p.zone));

// Global vertical + depth ranges across all lit LEDs.
let yLo = Infinity, yHi = -Infinity, xLo = Infinity, xHi = -Infinity;
for (const p of targets) {
  if (p.yNorm < yLo) yLo = p.yNorm; if (p.yNorm > yHi) yHi = p.yNorm;
  if (p.xNorm < xLo) xLo = p.xNorm; if (p.xNorm > xHi) xHi = p.xNorm;
}
const ySpan = (yHi - yLo) || 1;
const xSpan = (xHi - xLo) || 1;

// Depth ripple: each LED reads the cursor from `delay` frames ago, scaled by how
// far back it sits (front = no delay → leads; back = max delay → lags).
const maxDelay = Math.max(0, Math.round(CONFIG.depthRippleSec * CONFIG.fps));

// Arches: `u` = position along the physical strip (channel order within a universe,
// which runs left-leg base → crown → right-leg base). Orbs: `u` = left→right position.
const archZones = new Set(['main-arch', 'mini-arch-left', 'mini-arch-right']);
const byUniverse = new Map();
for (const p of targets) {
  if (!archZones.has(p.zone)) continue;
  if (!byUniverse.has(p.universe)) byUniverse.set(p.universe, []);
  byUniverse.get(p.universe).push(p);
}
for (const strip of byUniverse.values()) {
  strip.sort((a, b) => a.ch0 - b.ch0);
  const n = strip.length - 1 || 1;
  strip.forEach((p, i) => { p.u = i / n; });
}
for (const p of targets) {
  if (!archZones.has(p.zone)) p.u = p.zNorm;            // orbs map by horizontal position
  p.hue = ((p.yNorm - yLo) / ySpan);                    // 0..1 up the scene → hue offset
  p.delay = Math.round(((p.xNorm - xLo) / xSpan) * maxDelay);  // front→back lag, in frames
}

console.log(`Lighting ${targets.length} LEDs across zones: ${CONFIG.zones.join(', ')}`);
console.log(`(driving universes ${universes[0]}–${universes[universes.length - 1]}; non-target zones held dark)`);

// Per-target phosphor accumulator (linear RGB, decays each frame).
const acc = new Float32Array(targets.length * 3);

// ── Double pendulum physics (RK4 on the standard p5/myphysicslab equations) ────
let state = [CONFIG.theta1_0, 0, CONFIG.theta2_0, 0];

function derivs(s) {
  const { L1, L2, m1, m2, g, damping } = CONFIG;
  const [t1, w1, t2, w2] = s;
  const cs = Math.cos(t1 - t2), sn = Math.sin(t1 - t2);
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

// Lower-bob horizontal position on the facade (normalized 0..1).
function lowerBobZ() {
  const [t1, , t2] = state;
  return CONFIG.pivot.z + CONFIG.L1 * Math.sin(t1) + CONFIG.L2 * Math.sin(t2);
}

// HSV (h deg, s/v 0..1) → RGB 0..1.
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
const CHANNELS = 510;
const CID = Buffer.from('GothicFolly-AP01', 'binary');
const SOURCE_NAME = 'Gothic Folly Arches Pendulum';
let seq = 0;

function buildPacket(universe, data) {
  const buf = Buffer.alloc(126 + data.length);
  buf.writeUInt16BE(0x0010, 0);
  buf.write('ASC-E1.17\0\0\0', 4, 'binary');
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16);
  buf.writeUInt32BE(0x00000004, 18);
  CID.copy(buf, 22);
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38);
  buf.writeUInt32BE(0x00000002, 40);
  buf.write(SOURCE_NAME, 44, 'utf8');
  buf.writeUInt8(100, 108);
  buf.writeUInt8(seq & 0xff, 111);
  buf.writeUInt16BE(universe, 113);
  buf.writeUInt16BE(0x7000 | (buf.length - 115), 115);
  buf.writeUInt8(0x02, 117);
  buf.writeUInt8(0xa1, 118);
  buf.writeUInt16BE(0x0001, 121);
  buf.writeUInt16BE(data.length + 1, 123);
  buf.writeUInt8(0x00, 125);
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(buf, 126);
  return buf;
}

// ── Render loop ─────────────────────────────────────────────────────────────────
const socket = dgram.createSocket('udp4');
const dmx = new Map();
for (const u of universes) dmx.set(u, new Uint8Array(CHANNELS));

const dt = (1 / CONFIG.fps) * CONFIG.speed;
let frame = 0;
const invGamma = 1 / CONFIG.gamma;
const sigma2 = 2 * CONFIG.bandWidth * CONFIG.bandWidth;

// Ring buffer of recent cursor positions, so deeper arches can read older values.
const ucHistory = new Float64Array(maxDelay + 1).fill(0.5);
let histHead = 0;

function renderFrame() {
  // 1. Advance the (slowed) pendulum.
  const h = dt / CONFIG.substeps;
  for (let i = 0; i < CONFIG.substeps; i++) state = rk4Step(state, h);

  // 2. Cursor: lower-bob horizontal → uc ∈ [0,1].
  let sc = (lowerBobZ() - CONFIG.pivot.z) / (CONFIG.L1 + CONFIG.L2);
  sc = sc < -1 ? -1 : sc > 1 ? 1 : sc;
  const uc = (sc + 1) / 2;

  // Record the current cursor; deeper LEDs will read older entries (ripple).
  histHead = (histHead + 1) % ucHistory.length;
  ucHistory[histHead] = uc;

  // 3. Fade the persistence buffer.
  const decay = CONFIG.trailDecay;
  for (let i = 0; i < acc.length; i++) acc[i] *= decay;

  // 4. Time-drifting base hue (full spectrum).
  const t = (frame / CONFIG.fps) * CONFIG.speed;
  const baseHue = (t / CONFIG.hueCycleSec) * 360;

  // 5. Paint the cursor band (max-blend so it turns LEDs on and the fade trails).
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    const ucDelayed = ucHistory[(histHead - p.delay + ucHistory.length) % ucHistory.length];
    const d = p.u - ucDelayed;
    const bright = Math.exp(-(d * d) / sigma2);
    if (bright < 0.004) continue;
    const [r, g, b] = hsv2rgb(baseHue + CONFIG.heightSpread * p.hue, CONFIG.saturation, bright);
    const o = i * 3;
    if (r > acc[o])     acc[o]     = r;
    if (g > acc[o + 1]) acc[o + 1] = g;
    if (b > acc[o + 2]) acc[o + 2] = b;
  }

  // 6. Accumulator → DMX (gamma + clamp). Non-target channels stay 0 (dark).
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i], o = i * 3;
    const buf = dmx.get(p.universe);
    buf[p.ch0]     = toByte(acc[o]);
    buf[p.ch0 + 1] = toByte(acc[o + 1]);
    buf[p.ch0 + 2] = toByte(acc[o + 2]);
  }

  // 7. Emit every universe (so non-target zones are actively blacked out).
  for (const u of universes) socket.send(buildPacket(u, dmx.get(u)), CONFIG.port, CONFIG.host);
  seq++;
  frame++;
}

function toByte(v) {
  v = Math.pow(Math.min(1, Math.max(0, v)) * CONFIG.brightness, invGamma);
  return Math.round(v * 255);
}

const timer = setInterval(renderFrame, Math.round(1000 / CONFIG.fps));

console.log(`Streaming arches-pendulum → sACN ${CONFIG.host}:${CONFIG.port} @ ${CONFIG.fps}fps (speed ${CONFIG.speed}×)`);
console.log('Make sure relay.js is running and the simulator is open. Press Ctrl-C to stop.');

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
