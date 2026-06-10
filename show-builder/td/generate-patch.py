"""
generate-patch.py — Gothic Folly Rose Window: TouchDesigner Starter Patch

HOW TO USE:
  1. Open TouchDesigner (2023.11 or later recommended)
  2. File menu → Textport (or press Alt+T)
  3. In the Textport, run:
         run('path/to/generate-patch.py')
     Or: drag this file into TD and it will offer to run it.
  4. A "rose_window" component will appear in /project1.

WHAT IT CREATES:
  /project1/rose_window/
    cell_positions  — Table DAT with all 224 cell UV + position data
    effect_top      — GLSL TOP: your canvas to paint effects on (1024×1024)
    cell_sample     — Script CHOP: samples effect_top at each cell's UV coords
    sacn_out        — sACN Out CHOP: transmits to relay / F48V5 (universes 1–16)
    null_feedback   — Null CHOP: tap here to read cell RGB values in TD
    info_text       — Text DAT: quick reference for universe/channel mapping

ARCHITECTURE:
  [effect_top] → [cell_sample CHOP] → [sacn_out CHOP] → relay → browser sim
                                                        → F48V5 → LEDs (on playa)

  effect_top is a 1024×1024 texture. Paint whatever you want on it.
  cell_sample picks up the color at each cell's UV coordinate and packages
  it into DMX channels for sACN output.

  UV coords (uv_x, uv_y in cell-positions.csv):
    uv_x = 0 = left edge of window, 1 = right edge
    uv_y = 0 = bottom edge, 1 = top edge
    Center of window = (0.5, 0.5)

ADJUSTING THE sACN TARGET:
  Select sacn_out → Parameters → Network Address:
    127.0.0.1   = relay running on same Mac (development)
    <F48V5 IP>  = direct to Falcon controller (playa)

EXTENDING THIS PATCH:
  - Replace effect_top with any visual network (video, generative, etc.)
  - effect_top can be any resolution; UV sampling handles the mapping
  - For audio reactivity: feed an Audio Spectrum CHOP into your effect_top network
  - For multi-source blending: use a Composite TOP before cell_sample
"""

import csv, os, math

# ── Helpers ───────────────────────────────────────────────────────────────────

def make_op(parent_comp, op_type, name, x, y):
    """Create an operator, or return existing one."""
    existing = parent_comp.op(name)
    if existing:
        return existing
    node = parent_comp.create(op_type, name)
    node.nodeX = x
    node.nodeY = y
    return node

# ── Locate cell-positions.csv ─────────────────────────────────────────────────
# Try path relative to this script first, then relative to project
_script_dir = os.path.dirname(os.path.abspath(vars().get('__file__', __file__) if '__file__' in vars() else '.'))
_csv_path   = os.path.join(_script_dir, 'cell-positions.csv')
if not os.path.exists(_csv_path):
    raise FileNotFoundError(f"cell-positions.csv not found at {_csv_path}")

# Load cell data
_cells = []
with open(_csv_path) as f:
    for row in csv.DictReader(f):
        _cells.append(row)

print(f"Loaded {len(_cells)} cell positions from {_csv_path}")

# ── Build the patch ───────────────────────────────────────────────────────────
root = op('/project1')

# Container component for the whole patch
rose = make_op(root, containerCOMP, 'rose_window', 0, 0)

# 1. Cell positions Table DAT ─────────────────────────────────────────────────
tbl = make_op(rose, tableDAT, 'cell_positions', -600, 0)
tbl.clear()
headers = ['universe','channel','petal','angle_deg','cell',
           'x_mm','y_mm','r_mm','t_mm','grid_col','grid_row','uv_x','uv_y']
tbl.appendRow(headers)
for row in _cells:
    tbl.appendRow([row[h] for h in headers])

print("Created cell_positions DAT")

# 2. Effect TOP — GLSL animated test pattern ──────────────────────────────────
glsl = make_op(rose, glslTOP, 'effect_top', -300, 0)
glsl.par.resolution1 = 1024
glsl.par.resolution2 = 1024

# A simple animated radial + angular sweep as a starter pattern
glsl_code = '''\
// Gothic Folly Rose Window — starter GLSL effect
// uv.x = left→right, uv.y = bottom→top, center = (0.5, 0.5)
// 'iTime' is seconds since start (built-in TD uniform)

uniform float iTime;

out vec4 fragColor;

void main() {
    vec2 uv = vUV.st;
    vec2 centered = uv - vec2(0.5, 0.5);  // -0.5 .. +0.5
    float r = length(centered) * 2.0;      // 0=center, 1=edge
    float angle = atan(centered.x, centered.y);  // -pi .. pi

    // Radial wave
    float radial = 0.5 + 0.5 * sin(r * 6.0 - iTime * 2.0);
    // Spin sweep
    float spin   = 0.5 + 0.5 * sin(angle * 3.0 + iTime * 1.5);

    float mask = step(r, 1.0);  // clip to circle

    vec3 color = vec3(
        radial * spin,
        radial * (1.0 - spin),
        1.0 - radial
    ) * mask;

    fragColor = vec4(color, mask);
}
'''

# Write shader into a Text DAT, then point the GLSL TOP at it
shader_dat = make_op(rose, textDAT, 'effect_shader', -500, -150)
shader_dat.text = glsl_code
glsl.par.pixeldat = shader_dat.path
print("Created effect_top (GLSL animated pattern)")

# 3. Script CHOP — sample effect_top at each cell's UV position ───────────────
script_chop = make_op(rose, scriptCHOP, 'cell_sample', 0, 0)
script_chop.par.numsamples  = 1
script_chop.par.numchannels = 16 * 42  # 16 universes × 42 DMX channels

sample_script = f'''\
# cell_sample — Script CHOP
# Samples the effect TOP at each cell's UV position.
# Outputs 16 universes × 42 channels (672 channels total) for sACN.
#
# Channel naming: u<universe>c<channel>
# e.g. ch "u1c1" = universe 1, channel 1 (red of petal 0, cell 1b)

def cook(scriptOp):
    scriptOp.clear()

    effect = op("../effect_top")
    tbl    = op("../cell_positions")

    # One CHOP channel per DMX byte: universe 1 ch1..42, universe 2 ch1..42, ...
    # We build a flat array of 672 values then assign to named channels.
    values = {{}}  # "u<U>c<C>" -> float 0..1

    for r in range(1, tbl.numRows):  # skip header row
        uni  = int(tbl[r, "universe"])
        ch   = int(tbl[r, "channel"])
        uv_x = float(tbl[r, "uv_x"])
        uv_y = float(tbl[r, "uv_y"])

        # Sample the TOP at this UV coordinate
        pixel = effect.sample(u=uv_x, v=uv_y)

        values[f"u{{uni}}c{{ch}}"]   = pixel[0]   # R
        values[f"u{{uni}}c{{ch+1}}"] = pixel[1]   # G
        values[f"u{{uni}}c{{ch+2}}"] = pixel[2]   # B

    for name, val in sorted(values.items()):
        ch_op = scriptOp.appendChan(name)
        ch_op[0] = val
'''

script_dat = make_op(rose, textDAT, 'cell_sample_script', -200, -150)
script_dat.text = sample_script
script_chop.par.callbacks = script_dat.path
print("Created cell_sample Script CHOP")

# 4. sACN Out CHOP ─────────────────────────────────────────────────────────────
sacn = make_op(rose, sACNoutCHOP, 'sacn_out', 300, 0)
sacn.par.netaddress = '127.0.0.1'   # relay on same Mac; change to F48V5 IP on playa
sacn.par.universe   = 1
sacn.par.universes  = 16
# Connect cell_sample → sacn_out
script_chop.outputConnectors[0].connect(sacn)
print("Created sacn_out CHOP (→ 127.0.0.1, universes 1–16)")

# 5. Null feedback tap ─────────────────────────────────────────────────────────
null_fb = make_op(rose, nullCHOP, 'null_feedback', 150, -100)
script_chop.outputConnectors[0].connect(null_fb)

# 6. Info Text DAT ─────────────────────────────────────────────────────────────
info = make_op(rose, textDAT, 'info_text', -600, -300)
info.text = """\
GOTHIC FOLLY ROSE WINDOW — TouchDesigner patch
===============================================

Universe map: 16 universes, one per petal (clockwise from 12 o'clock)
  Universe 1 = petal 0 (12 o'clock, 0°)
  Universe 2 = petal 1 (22.5°)
  ...
  Universe 16 = petal 15 (337.5°)

14 cells per universe, channels 1–42, hub → rim:
  Ch  1– 3 : 1b  (innermost center)
  Ch  4– 6 : 2a  Ch  7– 9 : 2c
  Ch 10–12 : 3b
  Ch 13–15 : 4a  Ch 16–18 : 4c
  Ch 19–21 : 5a  Ch 22–24 : 5b  Ch 25–27 : 5c
  Ch 28–30 : 6a  Ch 31–33 : 6c
  Ch 34–36 : 7a  Ch 37–39 : 7b  Ch 40–42 : 7c  (outermost)

sACN destination:
  Development  →  127.0.0.1  (relay.js on your Mac)
  On playa     →  <F48V5 IP> (configure in sacn_out parameters)

Regenerate cell-positions.csv if geometry changes:
  python3 td/generate-td-data.py  (from project root)
"""

print("")
print("✓ Patch created: /project1/rose_window")
print("  Select rose_window and press 'Enter network' to open it.")
print("  Start the relay: cd relay && npm install && node relay.js")
print("  Then watch the browser simulator go LIVE.")
