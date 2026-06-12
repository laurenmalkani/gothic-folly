#!/usr/bin/env node
/**
 * relay.js — Gothic Folly Rose Window relay
 *
 * Two input modes (run simultaneously):
 *
 *   sACN (E1.31) — UDP port 5568
 *     Used by: TouchDesigner, xLights, any sACN controller
 *     This is the dev-time equivalent of the Falcon F48V5.
 *
 *   WLED HTTP poll — polls /json/live on a WLED device at ~25fps
 *     Used by: WLED running on an ESP32
 *     Enable by setting WLED_IP below (e.g. '192.168.1.42')
 *     Leave as null to disable.
 *
 * Both inputs broadcast cell color updates to browser clients
 * via WebSocket on port 3001.
 *
 * Universe assignment: pixel-map/universe-map.json
 *   Rose window: universes 1–16, one per petal, 14 RGB cells × 42 ch each
 *     WLED pixel order: pixel 0–13 = petal 0, 14–27 = petal 1, etc.
 *   Arches: universes 17–21, one per arch, raw channel passthrough
 *     Browser sim expects: { type: 'universe', universe: 17–21, channels: [r,g,b,...] }
 *
 * Usage:
 *   npm install
 *   node relay.js
 *
 * Then open the simulator: python3 -m http.server 8765 (from project root)
 */

'use strict';

const dgram     = require('dgram');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const SACN_PORT = 5568;
const WS_PORT   = 3001;
const UNIVERSE_MAP_FILE = path.join(__dirname, '..', 'pixel-map', 'universe-map.json');

// xLights linear mode: channels per universe as configured in xLights controller.
// xLights default is 510 (170 pixels × 3 channels, no split pixels across universes).
// If you changed this in xLights, update it here too.
const XLIGHTS_CHANNELS_PER_UNIVERSE = 510;

// xLights model layout — update if you change the model in xLights:
//   'linear'   — Rose Window custom model (default), or 16×14 matrix
//                Pixels assigned in petal/cell order: petal 0 ch 1–42, petal 1 ch 43–84, …
//   'grid48x7' — 48 strings × 7 nodes grid (rows=rings, cols=a/b/c)
const XLIGHTS_MODEL = 'linear';

// WLED HTTP polling — set to your WLED device's IP, or null to disable
// Example: const WLED_IP = '192.168.1.42';
const WLED_IP        = null;
const WLED_POLL_MS   = 40;   // ~25fps

// 48×7 grid cell map — indexed [row][colType], row 0=rim, row 6=hub; colType 0=a,1=b,2=c
// null = dead pixel (tracery bar, no LED at this position)
const GRID_MAP = [
  ['7a', '7b', '7c'],   // row 0 — rim (outermost ring)
  ['6a',  null, '6c'],  // row 1
  ['5a', '5b', '5c'],   // row 2
  ['4a',  null, '4c'],  // row 3
  [ null, '3b',  null], // row 4
  ['2a',  null, '2c'],  // row 5
  [ null, '1b',  null], // row 6 — hub (innermost)
];

// ── E1.31 constants ───────────────────────────────────────────────────────────
// ACN Packet Identifier at bytes 4–15: "ASC-E1.17\0\0\0"
const ACN_ID = Buffer.from([
  0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00
]);
const ROOT_VECTOR     = 0x00000004; // VECTOR_ROOT_E131_DATA
const FRAMING_VECTOR  = 0x00000002; // VECTOR_E131_DATA_PACKET
const DMP_VECTOR      = 0x02;       // VECTOR_DMP_SET_PROPERTY
const DMX_START_CODE  = 0x00;

// Byte offsets in E1.31 packet
const OFF_ACN_ID     = 4;
const OFF_ROOT_VEC   = 18;
const OFF_FRAME_VEC  = 40;
const OFF_UNIVERSE   = 113;  // uint16 big-endian
const OFF_DMP_VEC    = 117;
const OFF_PROP_COUNT = 123;  // uint16 BE — includes start code
const OFF_START_CODE = 125;
const OFF_DMX_DATA   = 126;
const MIN_PACKET_LEN = 126;

// ── Build lookup: universe → [{cell, petal, channelIndex}] ───────────────────
const umap   = JSON.parse(fs.readFileSync(UNIVERSE_MAP_FILE, 'utf8'));
const rw     = umap.zones.rose_window;
const lookup = {};  // key: universe number (int) — rose window only

// All non-rose-window zones with passthrough:true get raw channel passthrough to the browser sim.
// Relay sends: { type: 'universe', universe: N, channels: [...] }
const passthroughZones   = Object.values(umap.zones).filter(z => z.passthrough);
const passthroughUnivers = new Set(
  passthroughZones.flatMap(z => z.universes_detail.map(e => e.universe))
);

for (const entry of rw.universes_detail) {
  const cells = rw.cell_order.map((cell, i) => ({
    cell,
    petal: entry.petal,
    channelIndex: i * 3,  // 0-based byte offset into DMX data
  }));
  lookup[entry.universe] = cells;
}

const passthroughRanges = passthroughZones.map(z => `${z.universe_start}–${z.universe_end}`).join(', ');
console.log(`Loaded universe map: rose window universes 1–${rw.universes_detail.length} (${rw.pixels_per_universe} cells each), passthrough universes ${passthroughRanges}`);

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = http.createServer();
const wss    = new WebSocket.Server({ server });

wss.on('connection', ws => {
  console.log(`[WS] client connected  (${wss.clients.size} total)`);
  // Forward client→client messages (e.g. browser audio features → show scripts).
  // The relay normally only pushes sACN/WLED out; this lets the sim feed data back.
  ws.on('message', data => {
    const msg = data.toString();
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });
  ws.on('close', () =>
    console.log(`[WS] client disconnected (${wss.clients.size} total)`));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

server.listen(WS_PORT, () =>
  console.log(`[WS] WebSocket server listening on ws://localhost:${WS_PORT}`));

// ── WLED HTTP polling ─────────────────────────────────────────────────────────
// WLED's /json/live endpoint returns current pixel colors as hex strings.
// Response: { "leds": ["RRGGBB", "RRGGBB", ...], "n": 224 }
// Pixel order matches our universe map: pixels 0–13 = petal 0 (universe 1), etc.

function startWledPolling() {
  if (!WLED_IP) return;

  const wledUrl = `http://${WLED_IP}/json/live`;
  console.log(`[WLED] Polling ${wledUrl} every ${WLED_POLL_MS}ms`);

  function poll() {
    http.get(wledUrl, { timeout: WLED_POLL_MS * 2 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const { leds } = JSON.parse(body);
          if (!Array.isArray(leds)) return;

          // Map flat pixel array → {petal, cell, r, g, b}
          const updates = [];
          const cellOrder = rw.cell_order;
          const cellsPerPetal = rw.pixels_per_universe;

          for (let i = 0; i < leds.length && i < rw.total_pixels; i++) {
            const hex   = leds[i];
            const petal = Math.floor(i / cellsPerPetal);
            const cell  = cellOrder[i % cellsPerPetal];
            const r     = parseInt(hex.slice(0, 2), 16);
            const g     = parseInt(hex.slice(2, 4), 16);
            const b     = parseInt(hex.slice(4, 6), 16);
            updates.push({ petal, cell, r, g, b });
          }

          if (updates.length && wss.clients.size > 0) {
            broadcast({ type: 'cells', source: 'wled', data: updates });
          }
        } catch (e) { /* ignore parse errors */ }
      });
    }).on('error', () => { /* WLED offline — keep polling silently */ });
  }

  setInterval(poll, WLED_POLL_MS);
}

startWledPolling();

// ── sACN UDP socket ───────────────────────────────────────────────────────────
// Diagnostic: set RELAY_DEBUG=1 env var to log non-zero universes per second.
const RELAY_DEBUG = process.env.RELAY_DEBUG === '1';
const relayDiag = { universes: {} };
if (RELAY_DEBUG) {
  setInterval(() => {
    const keys = Object.keys(relayDiag.universes);
    if (keys.length) {
      const summary = keys.sort((a,b)=>a-b).map(u => `u${u}:${relayDiag.universes[u]}`).join(' ');
      console.log('[DIAG] non-zero universes:', summary);
      relayDiag.universes = {};
    }
  }, 1000);
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('error', err => {
  console.error('[UDP] socket error:', err.message);
});

socket.on('message', (msg) => {
  // Minimum length check
  if (msg.length < MIN_PACKET_LEN) return;

  // ACN Packet Identifier
  if (!msg.slice(OFF_ACN_ID, OFF_ACN_ID + 12).equals(ACN_ID)) return;

  // Vectors
  if (msg.readUInt32BE(OFF_ROOT_VEC)  !== ROOT_VECTOR)    return;
  if (msg.readUInt32BE(OFF_FRAME_VEC) !== FRAMING_VECTOR) return;
  if (msg[OFF_DMP_VEC]                !== DMP_VECTOR)     return;
  if (msg[OFF_START_CODE]             !== DMX_START_CODE) return;

  const universe     = msg.readUInt16BE(OFF_UNIVERSE);
  const propCount    = msg.readUInt16BE(OFF_PROP_COUNT);
  const dmxLength    = propCount - 1;  // subtract start code byte

  // ── Diagnostic: log non-zero universes once per second (RELAY_DEBUG=1) ───────
  if (RELAY_DEBUG) {
    const data = msg.slice(OFF_DMX_DATA, OFF_DMX_DATA + dmxLength);
    const nz   = data.reduce((s, v) => s + (v ? 1 : 0), 0);
    if (nz > 0) relayDiag.universes[universe] = nz;
  }

  // ── Passthrough zones (arches, mini arches, etc.): raw channels to browser sim ─
  if (passthroughUnivers.has(universe)) {
    const channels = Array.from(msg.slice(OFF_DMX_DATA, OFF_DMX_DATA + dmxLength));
    if (wss.clients.size > 0) {
      broadcast({ type: 'universe', universe, channels });
    }
    return;
  }

  const updates = [];
  const perPetalThreshold = rw.pixels_per_universe * 3;  // 42 channels (rose window)

  if (dmxLength > perPetalThreshold) {
    // ── Linear mode (xLights) ────────────────────────────────────────────────
    // xLights sends all pixels as a flat channel stream across universes.
    const pixelsPerUniverse = Math.floor(XLIGHTS_CHANNELS_PER_UNIVERSE / 3);
    const globalPixelOffset = (universe - 1) * pixelsPerUniverse;
    const numPixels = Math.floor(dmxLength / 3);

    if (XLIGHTS_MODEL === 'grid48x7') {
      // ── 48×7 grid mode ─────────────────────────────────────────────────────
      // 48 strings × 7 nodes, Vertical direction, Lower Left start in xLights.
      // Pixel order: string 0 nodes 0–6, string 1 nodes 0–6, …, string 47 nodes 0–6.
      // Node 0 = bottom (hub), node 6 = top (rim) → gridRow = 6 - node.
      for (let i = 0; i < numPixels; i++) {
        const globalPixel = globalPixelOffset + i;
        if (globalPixel >= 48 * 7) break;
        const string  = Math.floor(globalPixel / 7);
        const node    = globalPixel % 7;
        const petal   = Math.floor(string / 3);
        const colType = string % 3;
        const gridRow = 6 - node;
        const cell    = GRID_MAP[gridRow][colType];
        if (!cell) continue;  // dead pixel — tracery bar, no LED
        const r = msg[OFF_DMX_DATA + i * 3]     || 0;
        const g = msg[OFF_DMX_DATA + i * 3 + 1] || 0;
        const b = msg[OFF_DMX_DATA + i * 3 + 2] || 0;
        updates.push({ petal, cell, r, g, b });
      }
    } else {
      // ── 16×14 linear mode ──────────────────────────────────────────────────
      // 16 strings × 14 nodes — maps directly to petal/cell_order.
      for (let i = 0; i < numPixels; i++) {
        const globalPixel = globalPixelOffset + i;
        if (globalPixel >= rw.total_pixels) break;
        const petal     = Math.floor(globalPixel / rw.pixels_per_universe);
        const cellIndex = globalPixel % rw.pixels_per_universe;
        const cell      = rw.cell_order[cellIndex];
        const r = msg[OFF_DMX_DATA + i * 3]     || 0;
        const g = msg[OFF_DMX_DATA + i * 3 + 1] || 0;
        const b = msg[OFF_DMX_DATA + i * 3 + 2] || 0;
        updates.push({ petal, cell, r, g, b });
      }
    }
  } else {
    // ── Per-petal mode (TouchDesigner, hardware) ─────────────────────────────
    // Each universe carries exactly one petal: 14 cells × 3 channels = 42 ch.
    const cells = lookup[universe];
    if (!cells) return;  // universe not in our map

    for (const { cell, petal, channelIndex } of cells) {
      if (channelIndex + 2 >= dmxLength) break;  // incomplete packet
      const r = msg[OFF_DMX_DATA + channelIndex]     || 0;
      const g = msg[OFF_DMX_DATA + channelIndex + 1] || 0;
      const b = msg[OFF_DMX_DATA + channelIndex + 2] || 0;
      updates.push({ petal, cell, r, g, b });
    }
  }

  if (updates.length && wss.clients.size > 0) {
    broadcast({ type: 'cells', universe, data: updates });
  }
});

socket.bind(SACN_PORT, () => {
  // Join sACN multicast groups for all zones (239.255.0.U)
  const allUniverseEntries = [
    ...rw.universes_detail,
    ...passthroughZones.flatMap(z => z.universes_detail),
  ];
  for (const entry of allUniverseEntries) {
    const u = entry.universe;
    const multicast = `239.255.${(u >> 8) & 0xff}.${u & 0xff}`;
    try {
      socket.addMembership(multicast);
    } catch (e) {
      // Multicast join can fail if no network interface supports it — unicast still works
      console.warn(`[UDP] multicast join failed for ${multicast}: ${e.message}`);
    }
  }
  console.log(`[UDP] Listening for sACN on port ${SACN_PORT} (unicast + multicast)`);
  console.log('');
  console.log('Ready. Open the simulator, then start sending from TouchDesigner or xLights.');
});
