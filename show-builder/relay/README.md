# Gothic Folly — sACN Relay

Receives sACN (E1.31) from TouchDesigner, xLights, or any sACN controller,
and forwards cell color updates to the browser simulator via WebSocket.

This is the **development-time equivalent of the Falcon F48V5**.
Both receive identical sACN packets on the same universes and channels.
On playa, just point your controller at the F48V5's IP instead of your Mac.
Nothing else changes.

```
TouchDesigner / xLights
          │
     sACN UDP :5568
          │
     ┌────┴────┐
     │ relay.js│  ← this process (development)
     │  or     │
     │ F48V5   │  ← on playa
     └────┬────┘
          │
   WebSocket :3001   →  browser simulator
   Differential Cat6 →  SmartReceivers → LEDs
```

## Setup

Requires Node.js (v18+).

```bash
cd relay
npm install
node relay.js
```

Then open the simulator in your browser:
```bash
# from project root:
python3 -m http.server 8765
# → http://localhost:8765/sim/rose-window-sim.html
```

The simulator shows **● LIVE** in the toolbar when the relay is connected and
receiving data. It falls back to JS effects when no sACN data is flowing.

## Universe assignment

| Universe | Petal | Angle  |
|----------|-------|--------|
| 1        | 0     | 12 o'clock (0°)  |
| 2        | 1     | 22.5°  |
| …        | …     | …      |
| 16       | 15    | 337.5° |

Each universe carries **14 RGB cells = 42 channels**, hub → rim:

| Channels | Cell | Description          |
|----------|------|----------------------|
| 1–3      | 1b   | row 1 center (innermost) |
| 4–6      | 2a   | row 2 left           |
| 7–9      | 2c   | row 2 right          |
| 10–12    | 3b   | row 3 center         |
| 13–15    | 4a   | row 4 left           |
| 16–18    | 4c   | row 4 right          |
| 19–21    | 5a   | row 5 left           |
| 22–24    | 5b   | row 5 center         |
| 25–27    | 5c   | row 5 right          |
| 28–30    | 6a   | row 6 left           |
| 31–33    | 6c   | row 6 right          |
| 34–36    | 7a   | row 7 left           |
| 37–39    | 7b   | row 7 center (outermost) |
| 40–42    | 7c   | row 7 right          |

Full assignment in `../pixel-map/universe-map.json`.

## Configuring TouchDesigner

See `../td/README.md`.
