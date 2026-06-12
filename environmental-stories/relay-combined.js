#!/usr/bin/env node
/**
 * relay-combined.js — Gothic Folly combined sACN → WebSocket relay
 *
 * One relay that drives BOTH browser simulators at once:
 *   • Rose window  — universes 1–16  → {type:'cells'}    (rose-window-sim.html)
 *   • Arches       — universes 17–41 → {type:'universe'} (arch-simulator.html)
 *
 * Pipeline (unchanged from the rose-window setup, so TouchDesigner needs no
 * changes — same UDP port, same universes):
 *     TouchDesigner → sACN/E1.31 UDP:5568 → relay-combined.js → WebSocket:3001 → browsers
 *
 * Backward compatibility: the rose window cell mapping is the canonical one from
 * ../show-builder/pixel-map/universe-map.json, so the existing rose simulator
 * keeps working with zero changes. If that file is absent, universes 1–16 fall
 * back to raw {type:'universe'} frames and only the rose sim is affected.
 *
 * Node.js, depends only on `ws` (see package.json). Run:  node relay-combined.js
 */
'use strict';

const dgram     = require('dgram');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const WebSocket = require('ws');

// ── Config ────────────────────────────────────────────────────────────────────
const SACN_PORT = 5568;
const WS_PORT   = 3001;
const ARCH_UNIVERSE_FIRST = 17;     // 1–16 reserved for the rose window
const ARCH_UNIVERSE_LAST  = 41;     // 5 arches × 5 universes (170 px/universe)
const ROSE_MAP_FILE = path.join(__dirname, '..', 'show-builder', 'pixel-map', 'universe-map.json');

// ── E1.31 constants / offsets ───────────────────────────────────────────────────
const ACN_ID = Buffer.from([0x41,0x53,0x43,0x2d,0x45,0x31,0x2e,0x31,0x37,0x00,0x00,0x00]);
const ROOT_VECTOR = 0x00000004, FRAMING_VECTOR = 0x00000002, DMP_VECTOR = 0x02, DMX_START_CODE = 0x00;
const OFF_ACN_ID = 4, OFF_ROOT_VEC = 18, OFF_FRAME_VEC = 40, OFF_UNIVERSE = 113,
      OFF_DMP_VEC = 117, OFF_PROP_COUNT = 123, OFF_START_CODE = 125, OFF_DMX_DATA = 126, MIN_PACKET_LEN = 126;

// ── Rose window mapping (optional, for backward compatibility) ───────────────────
let roseLookup = null;              // universe(int) → [{cell, petal, channelIndex}]
try {
  const umap = JSON.parse(fs.readFileSync(ROSE_MAP_FILE, 'utf8'));
  const rw = umap.zones.rose_window;
  roseLookup = {};
  for (const entry of rw.universes_detail) {
    roseLookup[entry.universe] = rw.cell_order.map((cell, i) => ({ cell, petal: entry.petal, channelIndex: i * 3 }));
  }
  console.log(`Rose window map loaded: universes 1–${rw.universes_detail.length} (${rw.cell_order.length} cells each)`);
} catch {
  console.log('Rose window map not found — universes 1–16 will pass through as raw {type:"universe"}.');
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = http.createServer();
const wss = new WebSocket.Server({ server });
wss.on('connection', ws => {
  console.log(`[WS] client connected  (${wss.clients.size} total)`);
  // Forward client→client messages (e.g. browser audio features → show scripts).
  ws.on('message', data => {
    const msg = data.toString();
    for (const c of wss.clients) if (c !== ws && c.readyState === WebSocket.OPEN) c.send(msg);
  });
  ws.on('close', () => console.log(`[WS] client disconnected (${wss.clients.size} total)`));
});
function broadcast(obj) {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}
server.listen(WS_PORT, () => console.log(`[WS] listening on ws://localhost:${WS_PORT}`));

// ── Packet-rate diagnostics ─────────────────────────────────────────────────────
let pktCount = 0;
const activeUniverses = new Set();
setInterval(() => {
  const list = [...activeUniverses].sort((a, b) => a - b);
  const span = list.length ? `${list[0]}–${list[list.length - 1]} (${list.length})` : 'none';
  console.log(`[sACN] ${pktCount} pkt/s | active universes: ${span}`);
  pktCount = 0; activeUniverses.clear();
}, 1000);

// ── sACN UDP socket ─────────────────────────────────────────────────────────────
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
socket.on('error', err => console.error('[UDP] socket error:', err.message));

socket.on('message', msg => {
  if (msg.length < MIN_PACKET_LEN) return;
  if (!msg.slice(OFF_ACN_ID, OFF_ACN_ID + 12).equals(ACN_ID)) return;
  if (msg.readUInt32BE(OFF_ROOT_VEC) !== ROOT_VECTOR) return;
  if (msg.readUInt32BE(OFF_FRAME_VEC) !== FRAMING_VECTOR) return;
  if (msg[OFF_DMP_VEC] !== DMP_VECTOR || msg[OFF_START_CODE] !== DMX_START_CODE) return;

  const universe  = msg.readUInt16BE(OFF_UNIVERSE);
  const dmxLength = msg.readUInt16BE(OFF_PROP_COUNT) - 1;   // minus the start code
  pktCount++; activeUniverses.add(universe);

  // Rose window (1–16): emit cell updates so the rose simulator works unchanged.
  const cells = roseLookup && roseLookup[universe];
  if (cells) {
    const data = [];
    for (const { cell, petal, channelIndex } of cells) {
      if (channelIndex + 2 >= dmxLength) break;
      data.push({ petal, cell,
        r: msg[OFF_DMX_DATA + channelIndex]     || 0,
        g: msg[OFF_DMX_DATA + channelIndex + 1] || 0,
        b: msg[OFF_DMX_DATA + channelIndex + 2] || 0 });
    }
    if (data.length) broadcast({ type: 'cells', universe, data });
    return;
  }

  // Everything else (arches 17–41, and 1–16 if no rose map): raw channel frame.
  const channels = Array.from(msg.slice(OFF_DMX_DATA, OFF_DMX_DATA + dmxLength));
  broadcast({ type: 'universe', universe, channels });
});

socket.bind(SACN_PORT, () => {
  // Join multicast groups 239.255.0.U for every universe we care about (1–41).
  for (let u = 1; u <= ARCH_UNIVERSE_LAST; u++) {
    try { socket.addMembership(`239.255.${(u >> 8) & 0xff}.${u & 0xff}`); }
    catch (e) { /* unicast still works if multicast join fails */ }
  }
  console.log(`[UDP] listening for sACN on :${SACN_PORT} (universes 1–${ARCH_UNIVERSE_LAST}, unicast + multicast)`);
  console.log(`Arches on universes ${ARCH_UNIVERSE_FIRST}–${ARCH_UNIVERSE_LAST}. Open arch-simulator.html, then send from TouchDesigner.`);
});
