# Gothic Folly — Arch Simulator (Environmental Stories)

A browser-based LED simulator for the **5 entrance-tunnel arches** of *The Gothic
Folly* at Burning Man 2026. It receives live **sACN** from TouchDesigner via a
combined relay and visualizes all 3,450 pixels in real time — and runs a
standalone **four-phase ambient demo** when no data is present, so it's
presentable on its own.

```
TouchDesigner → sACN (E1.31, UDP 5568) → relay-combined.js → WebSocket (3001) → arch-simulator.html
```

This matches the rose-window pipeline exactly, so both simulators can run at the
same time off the same relay.

---

## Files

| File | What it is |
|------|------------|
| `arch-simulator.html` | Self-contained simulator + demo. **Double-click to open in Chrome** — no build, no server, no fetches. |
| `relay-combined.js` | Node relay: sACN → WebSocket for **both** rose window (1–16) and arches (17–41). |
| `arch-cell-positions.csv` | 3,450 rows of per-pixel geometry + universe/channel map (for TD). |
| `generate-arch-positions.js` | Regenerates the CSV (the HTML computes the same geometry internally). |
| `td/generate-arch-patch.py` | Auto-builds the TouchDesigner show component `/project1/arch_show`. |
| `package.json` | Declares the one dependency (`ws`). |

---

## Quick start

### 1. Run the relay
```bash
cd environmental-stories
npm install          # installs ws (once)
node relay-combined.js
```
You'll see packet-rate output once data is flowing:
```
[sACN] 1200 pkt/s | active universes: 17–41 (25)
```

### 2. Open the simulator
Just **double-click `arch-simulator.html`** (or drag it into Chrome). It opens on
`file://` and works immediately — the four-phase demo starts right away.

- The `● LIVE` dot is **grey** in demo mode, **green** when receiving sACN.
- Toolbar: current **phase name**, **BPM** slider (60–180, default 120), and
  manual **SUN / HEAT / RAIN / GROWTH** buttons (+ **AUTO** to resume cycling).

### 3. Build the TouchDesigner patch
In the TD **Textport**:
```python
exec(open('/full/path/to/environmental-stories/td/generate-arch-patch.py').read())
```
This creates `/project1/arch_show` with the Table DAT, Noise TOP, sampling Script
CHOP, phase Timer, optional Ableton Link, and a DMX Out CHOP streaming sACN on
universes 17–41. (TD parameter names drift between versions — a few lines marked
`✎` may need a tweak for your build; the script prints what it created.)

### 4. Playa deployment (point at the Falcon F48V5)
By default TD broadcasts sACN on the LAN. To unicast to the controller, set the
IP near the top of `td/generate-arch-patch.py` and re-run it:
```python
F48V5_IP = '192.168.1.50'     # your Falcon F48V5 address
```
The relay and simulator don't change for the playa — only TD's output target.

---

## Universe map

5 arches × 690 px (SK9822, 30 px/m). At the DMX-standard **170 px/universe**
(510 channels, no split pixels), each arch needs **5 universes**:

| Arch | Universes | Pixel range | Direction |
|:----:|:---------:|:-----------:|-----------|
| 1 | **17–21** | 0–689     | left base → peak → right base |
| 2 | **22–26** | 690–1379  | left base → peak → right base |
| 3 | **27–31** | 1380–2069 | left base → peak → right base |
| 4 | **32–36** | 2070–2759 | left base → peak → right base |
| 5 | **37–41** | 2760–3449 | left base → peak → right base |

Within an arch the 5 universes carry sequential 170-pixel runs (the 5th holds the
final 10 px): `u+0` left foot, `u+2` around the peak, `u+4` right foot. Channels
are 1-based, RGB, sequential.

> **Note on the universe count.** The original brief said "4 universes/arch,
> 17–36." That isn't physically possible: 690 px × 3 ch = **2,070 channels**, but
> 4 universes hold only 2,048 (512 ch each). So this uses **5 universes/arch →
> 25 total (17–41)**, keeping all 690 pixels. To re-pack, change
> `PIXELS_PER_UNIVERSE` in `generate-arch-positions.js` (and the matching
> constants in `arch-simulator.html` / `relay-combined.js`). Universes 1–16
> remain reserved for the rose window.

---

## The four-phase demo

Cycles automatically (a "bar" = 4 beats at the current BPM):

| Phase | Bars | Look | Palette |
|-------|:----:|------|---------|
| **SUN** | 16 | Warm gold-white, radial pulse from each arch's peak, slow breath at BPM/4 | `#FFD700 #FFF5C0 #FF8C00` |
| **HEAT** | 8 | Orange-red, upward noise shimmer base→peak, pulses on every beat, intensifies | `#FF4500 #FF8C00 #FFD700` |
| **RAIN** | 16 | Blue-white drops fall from peaks with gravity, white splash at the feet; density tracks (simulated) amplitude | `#FFFFFF #87CEEB #1E90FF` |
| **GROWTH** | 24 | Coloured tendrils climb from the feet, branching as they go | `#228B22 #9400D3 #FF6B6B #FFD700` |

The demo is fully self-contained (no relay needed). When real sACN arrives it
takes over automatically and the `● LIVE` dot turns green; the demo resumes on
signal loss.

---

## Hardware note — SK9822 vs WS2811

This simulator assumes **SK9822** LEDs at **30 px/m** (4-wire clocked, like
APA102 — fast PWM, no timing jitter). The geometry and universe map are derived
from that density (690 px per ~23 m arc). If a section is actually **WS2811**
(3-wire, 800 kHz), the per-pixel data is identical at the sACN layer — only the
controller's port protocol differs — but double-check the px/m, since WS2811
strips are often 30 or 60 px/m and would change the pixel counts here.
