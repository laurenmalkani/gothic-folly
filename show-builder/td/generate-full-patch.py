"""
generate-full-patch.py — Gothic Folly: Full Cathedral TouchDesigner Patch

HOW TO USE:
  1. Open TouchDesigner (2023.11 or later recommended)
  2. File menu → Textport (or press Alt+T)
  3. In the Textport, run:
         run('path/to/gothic-folly-td-starter/td/generate-full-patch.py')
     Or: exec(open('path/to/generate-full-patch.py').read())
  4. A "gothic_folly" component will appear in /project1.

WHAT IT CREATES:
  /project1/gothic_folly/
    pixel_positions      — Table DAT with all ~3,567 pixel positions + normalized coords
    effect_top           — GLSL TOP: animated spatial sweep effect (1024×1024)
    effect_shader        — Text DAT with the GLSL shader source
    pixel_sample         — Script CHOP: samples effect_top at each pixel's (z_norm, y_norm)
    pixel_sample_script  — Text DAT with the Script CHOP Python code
    sacn_out             — sACN Out CHOP: universes 17–48 → relay or F48V5
    info_text            — Text DAT: quick reference card

ARCHITECTURE:
  [effect_top] → [pixel_sample CHOP] → [sacn_out CHOP] → relay → browser sim
                                                         → F48V5 → LEDs (on playa)

  effect_top is a 1024×1024 GLSL texture. The starter effect is an animated
  horizontal sweep using z_norm so you immediately see color moving left-to-right
  across the whole cathedral in 3D space.

  pixel_sample samples effect_top at (z_norm, y_norm) for each pixel — z_norm is
  left/right position (0=left, 1=right), y_norm is height (0=ground, 1=top).

SPATIAL COORDINATES (from all-pixels-positions.csv):
  x_norm  — depth, 0=front (playa-facing) to 1=back
  y_norm  — height, 0=ground to 1=top of spires
  z_norm  — left-right, 0=left to 1=right

  Swap the UV sampling axes in pixel_sample_script to make effects sweep in
  different directions (e.g. height-based: use y_norm as the U coordinate).

ADJUSTING THE sACN TARGET:
  Select sacn_out → Parameters → Network Address:
    127.0.0.1   = relay running on same Mac (development)
    <F48V5 IP>  = direct to Falcon controller (playa)

THE ROSE WINDOW (universes 1–16) IS A SEPARATE COMPONENT:
  Run generate-patch.py for a rose_window component that drives the rose window
  using UV-based sampling appropriate for its circular geometry.
"""

import csv, os

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

# ── Locate all-pixels-positions.csv ──────────────────────────────────────────
_script_dir = os.path.dirname(os.path.abspath(vars().get('__file__', __file__) if '__file__' in vars() else '.'))
_csv_path   = os.path.join(_script_dir, 'all-pixels-positions.csv')
if not os.path.exists(_csv_path):
    raise FileNotFoundError(f"all-pixels-positions.csv not found at {_csv_path}")

_pixels = []
with open(_csv_path) as f:
    for row in csv.DictReader(f):
        _pixels.append(row)

print(f"Loaded {len(_pixels)} pixel positions from {_csv_path}")

_universes = sorted(set(int(r['universe']) for r in _pixels))
BASE_UNIVERSE = min(_universes)
N_UNIVERSES   = max(_universes) - BASE_UNIVERSE + 1
CHOP_CHANNELS = N_UNIVERSES * 510  # full DMX flat array for universes 17–48

print(f"Universes: {BASE_UNIVERSE}–{BASE_UNIVERSE + N_UNIVERSES - 1}  ({len(_universes)} used)")
print(f"Script CHOP output: {N_UNIVERSES} × 510 = {CHOP_CHANNELS} channels")

# ── Build the patch ───────────────────────────────────────────────────────────

root = op('/project1')
comp = make_op(root, containerCOMP, 'gothic_folly', 0, 0)

# 1. Pixel positions Table DAT ─────────────────────────────────────────────────
tbl = make_op(comp, tableDAT, 'pixel_positions', -600, 0)
tbl.clear()
headers = ['zone', 'pixel_id', 'universe', 'channel',
           'cat_x', 'cat_y', 'cat_z', 'x_norm', 'y_norm', 'z_norm']
tbl.appendRow(headers)
for row in _pixels:
    tbl.appendRow([row[h] for h in headers])
print("Created pixel_positions DAT")

# 2. Effect TOP — GLSL animated spatial sweep ──────────────────────────────────
glsl = make_op(comp, glslTOP, 'effect_top', -300, 0)
glsl.par.resolution1 = 1024
glsl.par.resolution2 = 1024

# Starter effect: animated horizontal sweep across z_norm (left-right)
# with a vertical height gradient.  Swap axes, change colors, or replace
# entirely with any other TOP network.
glsl_code = '''\
// Gothic Folly — Full Cathedral starter GLSL effect
//
// UV mapping used by pixel_sample:
//   uv.x = z_norm  (0=left, 1=right)
//   uv.y = y_norm  (0=ground, 1=top of spires)
//
// iTime: seconds since start (built-in TD uniform)

uniform float iTime;
out vec4 fragColor;

void main() {
    vec2 uv = vUV.st;
    float z = uv.x;  // left–right
    float y = uv.y;  // height

    // Animated left-to-right sweep
    float sweep = 0.5 + 0.5 * sin(z * 6.2832 - iTime * 1.5);

    // Height gradient for visual depth
    float vert = y;

    vec3 color = vec3(
        sweep,
        vert * (1.0 - sweep * 0.5),
        1.0 - vert
    );

    fragColor = vec4(color, 1.0);
}
'''

shader_dat = make_op(comp, textDAT, 'effect_shader', -500, -150)
shader_dat.text = glsl_code
glsl.par.pixeldat = shader_dat.path
print("Created effect_top (GLSL spatial sweep)")

# 3. Script CHOP — sample effect_top at each pixel's (z_norm, y_norm) ─────────
#
# Output: CHOP_CHANNELS values, one per DMX slot across universes 17–48.
# Channel index = (universe - BASE_UNIVERSE) * 510 + (dmx_channel - 1)
# so channel index 0 → Universe 17 Ch 1, index 509 → Universe 17 Ch 510, etc.
#
# The sACN Out CHOP (universe=17, universes=32) maps by position:
# CHOP ch 0 → Universe 17 DMX Ch 1, ch 1 → Ch 2, ... ch 510 → Universe 18 Ch 1.

script_chop = make_op(comp, scriptCHOP, 'pixel_sample', 0, 0)
script_chop.par.numsamples  = 1
script_chop.par.numchannels = CHOP_CHANNELS

sample_script = f'''\
# pixel_sample — Script CHOP
# Samples effect_top at each pixel's (z_norm, y_norm) spatial position.
# Outputs a flat DMX array: {N_UNIVERSES} universes × 510 channels = {CHOP_CHANNELS} values.
# Channel ordering: [u17c1, u17c2, ..., u17c510, u18c1, ..., u48c510]

def cook(scriptOp):
    scriptOp.clear()

    effect  = op("../effect_top")
    tbl     = op("../pixel_positions")
    base_u  = {BASE_UNIVERSE}
    n_ch    = {CHOP_CHANNELS}

    # Pre-allocate all DMX slots as 0
    values = [0.0] * n_ch

    for r in range(1, tbl.numRows):  # skip header row
        uni    = int(tbl[r, "universe"])
        ch     = int(tbl[r, "channel"])
        z_norm = float(tbl[r, "z_norm"])   # left–right: use as U
        y_norm = float(tbl[r, "y_norm"])   # height:     use as V

        # Sample the effect texture at this pixel's spatial position
        pixel = effect.sample(u=z_norm, v=y_norm)

        # Map to flat DMX index: R=ch, G=ch+1, B=ch+2 (1-based ch within universe)
        base_idx = (uni - base_u) * 510
        r_idx = base_idx + (ch - 1)
        g_idx = base_idx + ch
        b_idx = base_idx + (ch + 1)

        if r_idx < n_ch: values[r_idx] = pixel[0]
        if g_idx < n_ch: values[g_idx] = pixel[1]
        if b_idx < n_ch: values[b_idx] = pixel[2]

    for i, v in enumerate(values):
        ch_op = scriptOp.appendChan(f"ch{{i+1}}")
        ch_op[0] = v
'''

script_dat = make_op(comp, textDAT, 'pixel_sample_script', -200, -150)
script_dat.text = sample_script
script_chop.par.callbacks = script_dat.path
print("Created pixel_sample Script CHOP")

# 4. sACN Out CHOP ─────────────────────────────────────────────────────────────
sacn = make_op(comp, sACNoutCHOP, 'sacn_out', 300, 0)
sacn.par.netaddress = '127.0.0.1'
sacn.par.universe   = BASE_UNIVERSE
sacn.par.universes  = N_UNIVERSES
script_chop.outputConnectors[0].connect(sacn)
print(f"Created sacn_out CHOP (universes {BASE_UNIVERSE}–{BASE_UNIVERSE + N_UNIVERSES - 1} → 127.0.0.1)")

# 5. Info Text DAT ─────────────────────────────────────────────────────────────
info = make_op(comp, textDAT, 'info_text', -600, -300)
info.text = f"""\
GOTHIC FOLLY — Full Cathedral TouchDesigner patch
==================================================

Drives {len(_pixels)} pixels across {len(_universes)} universes ({BASE_UNIVERSE}–{BASE_UNIVERSE + N_UNIVERSES - 1}).

Universe map:
  17–21   Main arches (5)
  22–26   Mini arches — left (5)
  27–31   Mini arches — right (5)
  32–35   Quad arches — front top left/right (u32–33, u34–35)
  36–37   Quad arches — back top left/right
  38–41   Quad arches — back bottom left/right (u38–39, u40–41)
  42–45   Spires: front-left, front-right, back-left, back-right
  46      Spirelets ch1–60 + Canopy ch61+
  47      Canopy (overflow)
  48      Orbs (20 × RGB)

Spatial coordinates (from all-pixels-positions.csv):
  x_norm  0=front (playa-facing)  1=back
  y_norm  0=ground                1=top of spires (~18.7 m)
  z_norm  0=left                  1=right

Starter effect samples at (z_norm, y_norm): left-right sweep + height gradient.
To change the effect: edit effect_shader (GLSL) or replace effect_top entirely.
To sweep front-to-back: in pixel_sample_script, sample at (x_norm, y_norm).

sACN target:
  Development → 127.0.0.1 (relay.js on your Mac)
  On playa    → <F48V5 IP> (set in sacn_out parameters)

Rose window (universes 1–16) is a separate component.
Run generate-patch.py for the rose_window component.
"""

print("")
print(f"✓ Patch created: /project1/gothic_folly")
print("  Select gothic_folly and press 'Enter network' to open it.")
print("  Start the relay: cd relay && npm install && node relay.js")
print("  Then watch the browser simulator go LIVE.")
print("")
print("  TIP: The rose window is a separate component (generate-patch.py).")
