# Gothic Folly Show Builder — Getting Started

<!-- wiki-exclude-start -->
Welcome! This package is everything you need to build a light show for the
Gothic Folly — a full-scale LED cathedral at Burning Man 2026. Your sequence
could run on the real installation on the playa.

---
<!-- wiki-exclude-end -->

## What's in this package

```
show-builder/
  getting-started.md        ← you are here
  cathedral-3d-sim.html     ← 3D browser simulator (all zones)
  rose-window-sim.html      ← 2D rose window simulator
  pixel-map/                ← LED position data (used by the sims)
  relay/                    ← local relay server (live preview from xLights)
  xlights/                  ← xLights project: models, layout, config
  td/                       ← TouchDesigner data and patch generator
```

---

## Option A — xLights (recommended for beginners)

xLights is free, open-source sequencing software often used to create holiday light displays. The project files are already set up — you just open xLights and start creating.

Never used xLights before? These are the best places to get oriented first:
- [xLights Quick Start Guide](https://xlights.org/quick-start-guide/) — official written walkthrough
- [xLights Quick Start playlist](https://www.youtube.com/playlist?list=PLccGtinHO7Iy15tWfyQgr1THQbCf_1T9f) — official video series (YouTube)
- [xLights Beginner Seminar Jan 2021 — Part 2](https://www.youtube.com/watch?v=fuBly6mVFXM) — the xLights deep dive; Part 1 covers the intro hardware/setup context (YouTube)

> **Note:** The tutorials will talk about setting up controllers, models and layouts ... but we've done that for you for The Gothic Folly. So ignore those parts! In fact, you should take care NOT to accidentally save changes to the controllers or the models to ensure your show is set to work on Playa.

### 1. Install xLights

Download from **[xlights.org/releases](https://xlights.org/releases/)** — free, Mac/Windows/Linux. Run the installer and follow the prompts.

---

### 2. Open the project

When you first open xLights, it will ask you to pick a show directory. Navigate to wherever you put this package and select the `xlights` folder inside it.

> **What's a show directory?** xLights keeps all your models, sequences, and settings in one folder. We've already set that folder up for you — you just need to point xLights at it.

You can always change this later in the **Controllers** tab.

---

### 3. Explore the layout

Click the **Layout** tab. You'll see all the LED zones placed in 3D space: arches, spires, rose windows, canopy, orbs. Each zone is a separate model.

Being careful not to move any of the models in the window, click on the groups (represented as folders) to see which names apply to which pixels and shapes.

A couple of things to notice:
- The "spirelets," which are the little spires on many of the upper corners, appear as dots.
- The main spires appear as a grid. That's just so it's easier to apply various 2-dimensional patterns to the spires that will spin and swirl around them.

You won't use this view for the most part, but it's a good reference if you need it.

---

### 4. Try the example sequence

Switch to the **Sequencer** tab.

Use **File → Open Sequence**. Pick `example-sequence.xsq`. This is a very simple sequence that just puts some pink "bars" across the **Cathedral** group (everything).

Hit the **Replay Selection** button (looks like 🔁) and you should see the cathedral start to look pretty in the "House Preview" window. You can use your mouse to zoom in.

---

### 5. Start the relay.

The relay is a small program that listens for xLights output and forwards it to the 3D simulator. You'll need it running whenever you want the simulator to update live.

This step uses the **Terminal** (Mac) or **Command Prompt** (Windows) — a text window where you type commands. If you've never used one before, don't worry: you'll only need a handful of commands and we'll walk you through each one.

### First time only:

**Install Node.js:**
Download from **[nodejs.org](https://nodejs.org/)** — click the big "LTS" button. Run the installer and follow the prompts.

**Open a terminal:**
- **Mac:** Press **⌘ Space**, type `Terminal`, and hit Enter.
- **Windows:** Press the **Windows key**, type `cmd`, and hit Enter.

**Navigate to the relay folder:**
Type the following command, but **don't press Enter yet** — replace the path with the actual location of the `relay` folder on your computer:
```
cd /path/to/show-builder/relay
```
> **Shortcut:** On a Mac, you can type `cd ` (with a space after it), then drag the `relay` folder from Finder into the terminal window. The path fills in automatically. Then press Enter.

**Install relay dependencies:**
Type this line:
```
npm install
```
This downloads the relay's dependencies. It only needs to run once.

### Every session:

**Open a terminal and navigate to the relay folder** (same steps as above).

**Start the relay:**
Type this line:
```
node relay.js
```
You should see something like:
```
WebSocket server listening on ws://localhost:3001
UDP receiver listening on port 5568
```
Leave this terminal window open and running during your session.

> **Firewall popup?** If your computer asks whether to allow the relay to accept network connections, click **Allow**.

To stop the relay: go to its terminal window and press **Ctrl-C**.

---

### 6. Preview in the 3D simulator

Open `cathedral-3d-sim.html` from this package directly in your browser (double-click it in Finder/Explorer).

In xLights, click the **Output to Lights** button (💡) to start sending data. The simulator will show **● LIVE** in the toolbar when it's receiving. Hit play on your sequence and watch the cathedral light up!

To disconnect: click Output to Lights again.

**No internet? (playa mode)**

By default, the simulator loads its LED layout data from the web. On the playa without a connection, you can serve it locally instead. In a new terminal window, navigate to the `show-builder` folder (same steps as above, but go to `show-builder` instead of `show-builder/relay`) and run:
```
python3 -m http.server 8765
```
Then open **http://localhost:8765/cathedral-3d-sim.html** in your browser — it will detect the local address and use the bundled data automatically.

---

### 7. Make your own sequence

Use **File → New Sequence**. In the wizard, to just get a hang of things, pick "Animation" and then "40 fps" and then "Quick Start." If you want to get fancier and set your show to music, you can pick "Musical sequence" instead of "Animations."

Drag effects from the row of effects onto the different zones, either by group or individually. Play and see what happens.

A few tips:
- Use the **Cathedral** group to apply an effect to the entire installation at once
- Use subgroups (**Arches**, **Spires**, **Rose Window**, etc.) to target zones
- The **Bars* and **Pinwheel** effects are good starting points
- Don't forget to turn on your link to the 3D simulator by clicking "Output to Lights" which looks like 💡.

---

### 8. Render your sequence

When your sequence is ready: **File → Save**, then press **F5** to render (or use the **Render All** button, which looks like 🎨).

xLights writes two files: your `.xsq` (the sequence you'll send us) and a `.fseq` (a large rendered output — you don't need to send that one, we can regenerate it).

---

### 9. Share your show!

We'd love to display your sequence on the real installation on playa. [Scroll down for details. ↓](#sharing-your-show)

---

## Option B — TouchDesigner

TouchDesigner is a node-based visual programming environment. The included
data and patch generator let you drive all LED zones spatially using 3D
position coordinates — every pixel in the cathedral has a normalized (x, y, z)
position you can sample any way you like.

> **We need your help on this section!** I (Nick) am not a TouchDesigner user and have yet to dive in. I've generated these instructions with the help of Claude Code, but haven't had a chance to test them. Please reach out to me at nick@thegothicfolly.com if you have suggestions, tweaks or issues with these instructions!

### 1. Install TouchDesigner

Download from **[derivative.ca](https://derivative.ca)** — the free tier works for this project. TouchDesigner 2023.11 or later is recommended.

### 2. Generate the patch

The `td/` folder in this package contains two scripts:

- `generate-full-patch.py` — all zones except the rose window (universes 17–48, ~3,567 pixels)
- `generate-patch.py` — rose window only (universes 1–16, UV-based geometry)

Run one or both in TouchDesigner's Textport:

1. Open TouchDesigner
2. Open the Textport: **Alt+T** (or **Dialogs → Textport**)
3. Run the script by typing:
   ```
   run('/path/to/show-builder/td/generate-full-patch.py')
   ```
   Replace the path with the actual location of the file. Tip: drag the file into the Textport to auto-fill the path.
4. A `gothic_folly` component will appear in `/project1`. Open it to see the patch.

### 3. What's in the patch

```
gothic_folly/
  pixel_positions      ← Table DAT: all ~3,567 pixel positions + normalized coords
  effect_top           ← GLSL TOP: the effect texture (1024×1024)
  effect_shader        ← Text DAT: the GLSL shader source — edit this to make your effect
  pixel_sample         ← Script CHOP: samples effect_top at each pixel's position
  pixel_sample_script  ← Text DAT: the Python sampling code
  sacn_out             ← sACN Out CHOP: sends universes 17–48 to relay or F48V5
  info_text            ← Text DAT: quick reference card
```

The starter effect is an animated left-to-right sweep driven by each pixel's
`z_norm` coordinate. Edit `effect_shader` to replace it with your own effect.

**Spatial coordinate axes** (from `all-pixels-positions.csv`):
- `x_norm` — depth: 0 = playa-facing front, 1 = back
- `y_norm` — height: 0 = ground, 1 = top of spires
- `z_norm` — left/right: 0 = left, 1 = right

### 4. Preview in the 3D simulator

Start the relay the same way as in the xLights section (steps A–E in section 5 above). The `sacn_out` CHOP is pre-configured to send to `127.0.0.1` (the relay on your local machine). Open `cathedral-3d-sim.html` in your browser — it will show **● LIVE** when receiving data.

To deploy on playa, change the **Network Address** in `sacn_out`'s parameters from `127.0.0.1` to the Falcon F48V5 controller's IP address.

### 5. Rose window

The rose window (universes 1–16) uses a different geometry — 16 petals, each
with 14 cells mapped by UV position rather than 3D coordinates. Run
`generate-patch.py` to generate a separate `rose_window` component that handles
it correctly.

---


## Sharing your show

Our goal is to get your show displayed on The Gothic Folly at Burning Man! We're still working out the details, but if you are interested, reach out to Nick in the Lighting WhatsApp group or drop a note to nick@thegothicfolly.com

Once you've built something you're happy with, here's how to share it.

### From xLights

Send us your **`.xsq` file** — that's the sequence source file, found in
the `xlights/` folder with the name you gave your sequence. Include any
**audio file** if your sequence uses music.

You don't need to send the `.fseq` — that's a large rendered output file
we can regenerate ourselves.

### From TouchDesigner

Send us your **`.toe` file** — that's the full TouchDesigner project,
saved via **File → Save As**. It includes your patch and all settings.

### How to submit

We'll set up a formal process soon, but for now reach out to nick@thegothicfolly.com.

---

## Questions?

Reach out to Nick at nick@thegothicfolly.com or drop a note in The Gothic Folly WhatsApp group.
