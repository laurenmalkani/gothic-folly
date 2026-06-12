"""
generate-arch-patch.py — auto-build the Gothic Folly arch show in TouchDesigner
================================================================================
Run this in the TouchDesigner Textport:

    >>> exec(open('/full/path/to/environmental-stories/td/generate-arch-patch.py').read())

It builds a component `/project1/arch_show` containing the full pipeline:

    cells (Table DAT)  ──►  sample (Script CHOP)  ──►  dmxout (DMX Out CHOP → sACN)
    base_noise (Noise TOP) ─┘                                 ▲
    phase_timer (Timer CHOP) ─► phase (Constant CHOP) ────────┘ (drives the look)
    link (Ableton Link CHOP, optional) ─► bpm

Output: universes 17–41 (5 arches × 690 px × 3 ch, 170 px/universe), matching
arch-cell-positions.csv and relay-combined.js.

NOTE: TouchDesigner builds drift slightly in parameter names across versions.
This script sets the common ones and prints what it created; tweak the few
flagged parameters (✎) for your build if a parameter name differs.
"""

import os

# ── Locate arch-cell-positions.csv (sibling of the td/ folder) ──────────────────
HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else project.folder
CSV_PATH = os.path.normpath(os.path.join(HERE, '..', 'arch-cell-positions.csv'))

FIRST_UNIVERSE = 17
PIXELS_PER_UNIVERSE = 170
CHANNELS_PER_UNIVERSE = PIXELS_PER_UNIVERSE * 3   # 510

# Playa deployment: set this to the Falcon F48V5 IP, or leave '' for broadcast.
F48V5_IP = ''        # ✎ e.g. '192.168.1.50'


def build():
    root = op('/project1')
    if root.op('arch_show'):
        root.op('arch_show').destroy()           # rebuild cleanly each run
    show = root.create(baseCOMP, 'arch_show')
    show.nodeX, show.nodeY = 0, 0

    # 1. Cell table — the per-pixel geometry + universe/channel map.
    cells = show.create(tableDAT, 'cells')
    cells.par.file = CSV_PATH
    cells.par.loadonstartpulse.pulse()
    cells.nodeX, cells.nodeY = -600, 200

    # 2. Base visual — a Noise TOP we sample per pixel (swap for any TOP network).
    noise = show.create(noiseTOP, 'base_noise')
    noise.par.resolutionw, noise.par.resolutionh = 256, 128
    noise.par.type = 'sparse'
    noise.par.monochrome = False
    noise.nodeX, noise.nodeY = -600, 0

    # 3. Phase driver — a Timer cycles the four phases (SUN/HEAT/RAIN/GROWTH).
    timer = show.create(timerCHOP, 'phase_timer')
    # 16+8+16+24 = 64 bars. At 120 BPM (2 s/bar) the full cycle is 128 s.
    timer.par.length = 128
    timer.par.cycle = True
    timer.par.play = True
    timer.nodeX, timer.nodeY = -600, -220

    phase = show.create(constantCHOP, 'phase')   # 0..3 phase index for the look
    phase.par.name0 = 'phase'
    phase.nodeX, phase.nodeY = -380, -220

    # 4. Ableton Link for BPM sync, with a manual fallback.
    bpm = show.create(constantCHOP, 'bpm')
    bpm.par.name0, bpm.par.value0 = 'bpm', 120
    bpm.nodeX, bpm.nodeY = -380, -320
    try:
        link = show.create(abletonlinkCHOP, 'link')   # ✎ type name may be 'linkCHOP' on some builds
        link.par.enable = True
        bpm.par.value0.expr = "op('link')['tempo']"
        bpm.par.value0.bindExpr = ''
        print('  Ableton Link CHOP created — BPM follows Link tempo.')
    except Exception:
        print('  Ableton Link CHOP unavailable — using manual bpm Constant CHOP (default 120).')

    # 5. Script CHOP — sample the base TOP at every cell's (uv_x, uv_y) → RGB.
    sample = show.create(scriptCHOP, 'sample')
    sample.inputCOMPConnectors  # ensure exists
    code = show.create(textDAT, 'sample_code')
    code.text = SCRIPT_CHOP_CODE
    sample.par.callbacks = code
    # wire references the script reads by name: cells (DAT), base_noise (TOP)
    sample.nodeX, sample.nodeY = -200, 0

    # 6. DMX Out CHOP — stream the sampled channels as sACN on universes 17–41.
    dmx = show.create(dmxoutCHOP, 'dmxout')
    dmx.inputConnectors[0].connect(sample)
    try:
        dmx.par.interface = 'sACN'                 # ✎ some builds: par.protocol / par.format
    except Exception:
        pass
    dmx.par.startuniverse = FIRST_UNIVERSE
    try:
        dmx.par.channelsperuniverse = CHANNELS_PER_UNIVERSE
    except Exception:
        pass
    if F48V5_IP:
        try:
            dmx.par.unicastaddress = F48V5_IP      # ✎ unicast to the Falcon on the playa
            dmx.par.sendto = 'Unicast'
        except Exception:
            pass
    dmx.par.active = True
    dmx.nodeX, dmx.nodeY = 40, 0

    print('Built /project1/arch_show:')
    for o in ['cells', 'base_noise', 'phase_timer', 'phase', 'bpm', 'sample', 'dmxout']:
        print('   •', show.op(o).path if show.op(o) else '(missing) ' + o)
    print(f'CSV: {CSV_PATH}')
    print(f'sACN: universes {FIRST_UNIVERSE}–{FIRST_UNIVERSE + 24}  ({CHANNELS_PER_UNIVERSE} ch/universe)')
    print("Falcon IP:", F48V5_IP or '(broadcast — set F48V5_IP for playa)')


# The Script CHOP body: read the cell table once, cache uv arrays, then each cook
# sample the noise TOP at those uv coords and emit r/g/b channels in CSV order
# (so the DMX Out CHOP maps them straight onto universes 17–41).
SCRIPT_CHOP_CODE = r'''
import numpy as np

_uv = None   # cached (uvx, uvy) arrays — rebuilt if the table row count changes

def _load_uv():
    t = op('cells')
    n = t.numRows - 1
    uvx = np.empty(n, np.float32); uvy = np.empty(n, np.float32)
    cx = t.col('uv_x')[0].col; cy = t.col('uv_y')[0].col
    for i in range(n):
        uvx[i] = float(t[i + 1, cx].val)
        uvy[i] = float(t[i + 1, cy].val)
    return uvx, uvy

def onCook(scriptOp):
    global _uv
    scriptOp.clear()
    t = op('cells')
    n = t.numRows - 1
    if n <= 0:
        return
    if _uv is None or _uv[0].shape[0] != n:
        _uv = _load_uv()
    uvx, uvy = _uv

    arr = op('base_noise').numpyArray(delayed=False)   # (h, w, 4) floats 0..1
    h, w = arr.shape[0], arr.shape[1]
    xi = np.clip((uvx * (w - 1)).astype(np.int32), 0, w - 1)
    yi = np.clip(((1.0 - uvy) * (h - 1)).astype(np.int32), 0, h - 1)   # v=1 is the peak
    rgb = arr[yi, xi, 0:3]                              # (n, 3)

    r = scriptOp.appendChan('r'); r.vals = rgb[:, 0].tolist()
    g = scriptOp.appendChan('g'); g.vals = rgb[:, 1].tolist()
    b = scriptOp.appendChan('b'); b.vals = rgb[:, 2].tolist()
    return
'''

build()
