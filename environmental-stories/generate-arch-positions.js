#!/usr/bin/env node
/**
 * generate-arch-positions.js — build arch-cell-positions.csv for The Gothic Folly
 *
 * 5 main arches (entrance tunnel), each a half-ellipse of SK9822 LEDs at 30 px/m.
 * Pixels are placed at EQUAL ARC-LENGTH intervals along each arch (how the strip
 * physically sits), left base → peak → right base. The browser simulator
 * (arch-simulator.html) computes the same geometry internally so it can run
 * standalone; this file produces the CSV that the relay + TouchDesigner use.
 *
 *   CSV columns:
 *     pixel_index          global pixel id, 0 … 3449
 *     arch_index           0 … 4 (left → right)
 *     position_along_arch  0..1 along the arc (= uv_x)
 *     x_screen, y_screen   pixel position in the 1400×400 canvas
 *     uv_x                 0..1 along arch (left → right)  — TD texture U
 *     uv_y                 0..1 height (0 = base, 1 = peak) — TD texture V
 *     universe, channel    sACN target (1-based DMX channel)
 *
 * Universe mapping (see README): 170 px/universe (510 ch, no pixel split),
 * 5 universes/arch → universes 17–41. NB: the brief said "4 per arch / 17–36",
 * but 690 px × 3 ch = 2070 ch can't fit 4 universes (2048 ch max), so 5 is the
 * physically-correct count. Change PIXELS_PER_UNIVERSE to re-pack.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── Installation constants ──────────────────────────────────────────────────
const ARCHES            = 5;
const PIXELS_PER_ARCH   = 690;       // 23 m arc × 30 px/m
const SPAN_M            = 20.38;      // arch width  (metres) — informs uv only
const HEIGHT_M          = 4.47;       // arch height (metres)
const FIRST_UNIVERSE    = 17;         // 1–16 reserved for the rose window
const PIXELS_PER_UNIVERSE = 170;      // 510 channels, DMX-standard (no split)
const UNIVERSES_PER_ARCH  = Math.ceil(PIXELS_PER_ARCH / PIXELS_PER_UNIVERSE); // 5

// ── Canvas layout ───────────────────────────────────────────────────────────
const CANVAS_W = 1400;
const CANVAS_H = 400;
const SLOT_W   = CANVAS_W / ARCHES;   // horizontal room per arch (280 px)
const ARCH_HALF_W = 118;              // screen half-span of each arch (a)
const ARCH_H      = 286;              // screen height of each arch    (b)
const BASE_Y      = 366;              // y of the arch feet (near canvas bottom)

// Half-ellipse, parametrised by φ ∈ [0, π]:
//   x(φ) = cx − a·cos φ      (φ=0 → left base, φ=π → right base)
//   y(φ) = BASE_Y − b·sin φ  (φ=π/2 → peak)
//   height fraction = sin φ   (0 at the feet, 1 at the peak)  → uv_y
const dxdphi = (a, phi) => a * Math.sin(phi);
const dydphi = (b, phi) => -b * Math.cos(phi);

// Build a fine φ→arc-length table, then resample at equal arc-length steps so
// the 690 pixels are evenly spaced along the curve (not evenly spaced in φ).
function archPhis(a, b, n) {
  const STEPS = 4000;
  const dphi = Math.PI / STEPS;
  const cum = new Float64Array(STEPS + 1);
  for (let i = 1; i <= STEPS; i++) {
    const phiMid = (i - 0.5) * dphi;
    const ds = Math.hypot(dxdphi(a, phiMid), dydphi(b, phiMid)) * dphi;
    cum[i] = cum[i - 1] + ds;
  }
  const total = cum[STEPS];
  const phis = new Float64Array(n);
  let j = 0;
  for (let p = 0; p < n; p++) {
    const target = (n === 1 ? 0 : p / (n - 1)) * total;   // arc length to reach
    while (j < STEPS && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;                 // interpolate within step
    const frac = (target - cum[j]) / seg;
    phis[p] = (j + frac) * dphi;
  }
  return phis;
}

const rows = [['pixel_index', 'arch_index', 'position_along_arch',
               'x_screen', 'y_screen', 'uv_x', 'uv_y', 'universe', 'channel']];

let pixelIndex = 0;
for (let arch = 0; arch < ARCHES; arch++) {
  const cx = SLOT_W * arch + SLOT_W / 2;
  const phis = archPhis(ARCH_HALF_W, ARCH_H, PIXELS_PER_ARCH);
  for (let i = 0; i < PIXELS_PER_ARCH; i++) {
    const phi = phis[i];
    const x = cx - ARCH_HALF_W * Math.cos(phi);
    const y = BASE_Y - ARCH_H * Math.sin(phi);
    const along = PIXELS_PER_ARCH === 1 ? 0 : i / (PIXELS_PER_ARCH - 1);
    const uvY = Math.sin(phi);
    const universe = FIRST_UNIVERSE + arch * UNIVERSES_PER_ARCH + Math.floor(i / PIXELS_PER_UNIVERSE);
    const channel  = (i % PIXELS_PER_UNIVERSE) * 3 + 1;   // 1-based DMX channel
    rows.push([
      pixelIndex, arch, along.toFixed(4),
      x.toFixed(1), y.toFixed(1), along.toFixed(4), uvY.toFixed(4),
      universe, channel,
    ]);
    pixelIndex++;
  }
}

const out = path.join(__dirname, 'arch-cell-positions.csv');
fs.writeFileSync(out, rows.map(r => r.join(',')).join('\n') + '\n');
const lastUni = FIRST_UNIVERSE + ARCHES * UNIVERSES_PER_ARCH - 1;
console.log(`Wrote ${pixelIndex} pixels → ${out}`);
console.log(`Arches: ${ARCHES} × ${PIXELS_PER_ARCH} px | ${UNIVERSES_PER_ARCH} universes/arch | universes ${FIRST_UNIVERSE}–${lastUni}`);
console.log(`Geometry: span ${SPAN_M} m × height ${HEIGHT_M} m, drawn as half-ellipses in ${CANVAS_W}×${CANVAS_H}`);
