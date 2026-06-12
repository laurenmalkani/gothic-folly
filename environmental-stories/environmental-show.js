#!/usr/bin/env node
/**
 * environmental-show.js — Gothic Folly: Environmental Stories
 *
 * An ambient, full-installation light show. Paints across the WHOLE pixel map and
 * is watched live in the existing 3D simulator — same pipeline as the pendulum:
 *
 *     this script ──sACN/E1.31 UDP:5568──▶ relay.js ──WS:3001──▶ cathedral-3d-sim.html
 *
 * Phases (more to come): SUN, then HEAT, RAIN, GROWTH.
 *
 * ── SUN ──────────────────────────────────────────────────────────────────────
 * A sun in the spirit of Olafur Eliasson's "The Weather Project": the ROSE WINDOW
 * is the glowing sun disc (warm amber core → deep-red rim); the rest of the
 * structure is a dim, hazy warm atmosphere — a silhouette around the sun. Warmth
 * radiates and circulates back with depth, and a ring of light PULSES outward
 * from the sun on every beat, locked to the music's BPM.
 *
 * BPM comes from the sim's audio (click "Enable Audio" in cathedral-3d-sim.html);
 * with no audio it free-runs at CONFIG.sun.pulse.defaultBpm.
 *
 * Run (from the repo):
 *     node show-builder/relay/relay.js                       # relay (universes 1–48)
 *     cd show-builder && python3 -m http.server 8766         # serve the 3D sim
 *     node environmental-stories/environmental-show.js       # this show
 *   then open  http://localhost:8766/cathedral-3d-sim.html
 *
 * Pure Node (dgram + fs), zero dependencies. Tune CONFIG below.
 */
'use strict';

const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');

const TAU = Math.PI * 2;

// ── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  host: '127.0.0.1',
  port: 5568,
  fps:  40,
  relayUrl: 'ws://localhost:3001',     // for BPM/beat from the sim's audio

  sun: {
    // Sun centre (front, where the rose window sits). Normalized coords:
    // x = depth (0 front … 1 back), y = height, z = left↔right.
    center: { x: 0.09, y: 0.40, z: 0.50 },

    // ROSE WINDOW — the sun disc itself: brightest, warm amber core → deep rim.
    rose: { coreVal: 0.95, rimVal: 0.40, span: 0.18 },

    // STRUCTURE — dim, hazy warm atmosphere around the sun (arches toned down).
    structure: { ambient: 0.13, heatWeight: 0.5, depthFalloff: 1.6, valMax: 0.50 },

    // Slow circular heat with depth.
    swirlArms: 2, rotSpeed: 0.05, flowFreq: 1.3, flowSpeed: 0.05,

    // BPM pulse: a ring of warmth radiates from the sun on each beat and crosses
    // the structure over `travelBeats` beats.
    pulse: { weight: 0.55, travelBeats: 2.2, width: 0.11, defaultBpm: 60,
             roseGain: 0.30, structGain: 0.40 },

    // Warm colour ramp (reddish when dim → amber when hot), capped (never white).
    hueLo: 4, hueHi: 34, satLo: 1.0, satHi: 0.74, valBase: 0.07, valGain: 0.58,
  },
};

const HERE     = __dirname;
const SHOW_DIR  = path.join(HERE, '..', 'show-builder');
const CSV_PATH  = path.join(SHOW_DIR, 'td', 'all-pixels-positions.csv');
const ROSE_MAP  = path.join(SHOW_DIR, 'pixel-map', 'universe-map.json');

// ── Load structure geometry (universes 17–48) ─────────────────────────────────
function loadStructure(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const h = lines[0].split(',').map(s => s.trim());
  const ci = n => h.indexOf(n);
  const [cZone, cU, cCh, cX, cY, cZ] =
    ['zone', 'universe', 'channel', 'x_norm', 'y_norm', 'z_norm'].map(ci);
  const all = [], universes = new Set();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const universe = parseInt(f[cU], 10); universes.add(universe);
    all.push({ rose: false, universe, ch0: parseInt(f[cCh], 10) - 1,
      x: parseFloat(f[cX]), y: parseFloat(f[cY]), z: parseFloat(f[cZ]) });
  }
  return { all, universes };
}

// ── Build rose-window cells (universes 1–16) as the sun disc ───────────────────
// Each cell's ring number (1 = hub/centre … 7 = rim) gives its radial position,
// so the rose reads as a radial sun with no extra geometry. universe = petal+1,
// channel offset = index-in-cell_order × 3 (matches relay.js / the rose sim).
function loadRose(mapPath) {
  let cellOrder;
  try { cellOrder = JSON.parse(fs.readFileSync(mapPath, 'utf8')).zones.rose_window.cell_order; }
  catch { cellOrder = ['1b','2a','2c','3b','4a','4c','5a','5b','5c','6a','6c','7a','7b','7c']; }
  const cells = [], universes = new Set();
  for (let petal = 0; petal < 16; petal++) {
    const universe = petal + 1; universes.add(universe);
    cellOrder.forEach((cell, i) => {
      const ring = parseInt(cell[0], 10);            // 1..7
      cells.push({ rose: true, universe, ch0: i * 3, radial: (ring - 1) / 6 });
    });
  }
  return { cells, universes };
}

const struct = loadStructure(CSV_PATH);
const rose = loadRose(ROSE_MAP);
const targets = [...struct.all, ...rose.cells];
const universes = [...new Set([...struct.universes, ...rose.universes])].sort((a, b) => a - b);

// Precompute, per structure pixel, distance + angle from the sun, and a unified
// "sunDist" 0..1 (rose occupies the inner span, the structure the rest) so the
// beat pulse travels continuously from the sun out through the whole space.
const SC = CONFIG.sun.center;
let maxD = 1e-6;
for (const p of struct.all) {
  p.dist = Math.hypot(p.x - SC.x, p.y - SC.y, p.z - SC.z);
  p.ang  = Math.atan2(p.z - SC.z, p.x - SC.x);
  if (p.dist > maxD) maxD = p.dist;
}
const span = CONFIG.sun.rose.span;
for (const p of struct.all) p.sunDist = span + (1 - span) * (p.dist / maxD);
for (const p of rose.cells) p.sunDist = p.radial * span;

console.log(`Environmental Stories — ${targets.length} pixels (rose ${rose.cells.length} + structure ${struct.all.length})`);
console.log(`(universes ${universes[0]}–${universes[universes.length - 1]})`);

// ── HSV → RGB (0..1) ────────────────────────────────────────────────────────────
function hsv2rgb(hh, s, v) {
  hh = ((hh % 360) + 360) % 360 / 60;
  const c = v * s, x = c * (1 - Math.abs((hh % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 1)      { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else             { r = c; b = x; }
  return [r + m, g + m, b + m];
}

// ── Audio link: BPM + beat from the sim (Node global WebSocket, no deps) ─────────
const audioState = { bpm: 0, beatPhase: 0, beatCount: 0, ttl: 0 };
function connectAudio() {
  if (typeof WebSocket === 'undefined') return;
  let ws;
  try { ws = new WebSocket(CONFIG.relayUrl); } catch { setTimeout(connectAudio, 2000); return; }
  ws.addEventListener('open',  () => console.log('Audio link connected → pulses lock to the music BPM.'));
  ws.addEventListener('close', () => { audioState.ttl = 0; setTimeout(connectAudio, 2000); });
  ws.addEventListener('error', () => {});
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'audio') return;
    audioState.bpm = m.bpm || 0;
    audioState.beatPhase = m.beatPhase || 0;
    if (m.beat) audioState.beatCount++;
    audioState.ttl = CONFIG.fps;
  });
}

// ── sACN / E1.31 packet builder ────────────────────────────────────────────────
const CHANNELS = 510;
const CID = Buffer.from('GothicFolly-ES01', 'binary');
const SOURCE_NAME = 'Gothic Folly Environmental Stories';
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
// Rose universes (1–16) carry 14 cells × 3 = 42 channels so the relay uses its
// per-petal cell mapping (it switches to xLights "linear" mode above 42). The
// structure universes use the full 510.
const ROSE_CHANNELS = 42;
const roseUniSet = rose.universes;
for (const u of universes) dmx.set(u, new Uint8Array(roseUniSet.has(u) ? ROSE_CHANNELS : CHANNELS));
let frame = 0, beats = 0;

function renderSun(t, dt) {
  const S = CONFIG.sun, P = S.pulse, R = S.rose, ST = S.structure;
  audioState.ttl = Math.max(0, audioState.ttl - 1);
  const haveAudio = audioState.ttl > 0 && audioState.bpm > 0;
  // Continuous beat position: lock to the music when present, else free-run.
  beats = haveAudio ? audioState.beatCount + audioState.beatPhase
                    : beats + dt * (P.defaultBpm / 60);
  const pw2 = 2 * P.width * P.width;

  for (const p of targets) {
    // Beat pulse — a ring radiating out from the sun, one per beat.
    const fr = beats - p.sunDist * P.travelBeats;
    const d  = fr - Math.round(fr);
    const pulse = Math.exp(-(d * d) / pw2);

    let val;
    if (p.rose) {
      // The sun disc: bright amber centre → deep-red rim.
      val = R.rimVal + (R.coreVal - R.rimVal) * (1 - p.radial) + pulse * P.roseGain;
      if (val > 0.98) val = 0.98;
    } else {
      // Dim hazy atmosphere with slow circular heat + depth gradient.
      const depthWarm = Math.exp(-p.x * ST.depthFalloff);
      const swirl = 0.5 + 0.5 * Math.sin(S.swirlArms * p.ang - t * S.rotSpeed * TAU);
      const flow  = 0.5 + 0.5 * Math.sin((p.x * S.flowFreq - t * S.flowSpeed) * TAU);
      const I = ST.ambient + ST.heatWeight * depthWarm * (0.5 + 0.5 * swirl) * (0.55 + 0.45 * flow);
      val = S.valBase + S.valGain * I + pulse * P.structGain;
      if (val > ST.valMax + pulse * P.structGain) val = ST.valMax + pulse * P.structGain;
    }
    if (val < 0) val = 0; else if (val > 1) val = 1;

    // Warm colour: reddish when dim, amber when hot — tied to brightness.
    const ct = Math.min(1, val / 0.85);
    const [r, g, b] = hsv2rgb(S.hueLo + (S.hueHi - S.hueLo) * ct,
                              S.satLo + (S.satHi - S.satLo) * ct, val);
    const buf = dmx.get(p.universe);
    buf[p.ch0]     = (r * 255 + 0.5) | 0;
    buf[p.ch0 + 1] = (g * 255 + 0.5) | 0;
    buf[p.ch0 + 2] = (b * 255 + 0.5) | 0;
  }
}

function renderFrame() {
  const t = frame / CONFIG.fps, dt = 1 / CONFIG.fps;
  renderSun(t, dt);
  for (const u of universes) socket.send(buildPacket(u, dmx.get(u)), CONFIG.port, CONFIG.host);
  seq++; frame++;
}

const timer = setInterval(renderFrame, Math.round(1000 / CONFIG.fps));
connectAudio();
console.log(`Streaming SUN → sACN ${CONFIG.host}:${CONFIG.port} @ ${CONFIG.fps}fps`);
console.log('Relay + cathedral-3d-sim.html must be running. Click "Enable Audio" in the sim to lock pulses to BPM. Ctrl-C to stop.');

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
