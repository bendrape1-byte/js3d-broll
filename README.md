# js3d-broll

A Claude Code skill that renders lit 3D B-roll in JavaScript: three.js inside a Remotion project, out to
1080x1920 (or 16:9) clips for a CapCut overlay.

It started as a test. A crash-test dummy grabbing a rebound and landing had been rendered in Blender Cycles, which
took 37 min 42 s for 150 frames on an M4. Ported line by line to three.js, the same clip renders in about 50 s.
Every frame scores 31 to 33 dB PSNR against Cycles' own PNGs, and the geometry lines up to the pixel. Side by side
you can still tell: surfaces facing the floor come out 10 to 15 levels darker, because there is no real bounce light.

## How it works

Cycles averages many random light paths per pixel. This skill renders the whole frame 32 times and averages those
passes. Each pass gets its own shutter time, lens point, point on the key light and sub-pixel offset, which adds up
to motion blur, depth of field, soft shadows and anti-aliasing at about 0.25 s a frame.

The glossy floor is a mirrored render, blurred more the further the reflected object sits from the floor. Colour
goes through Blender's own AgX "Medium High Contrast" view, baked into a lookup table, because three.js's AgX is up
to 48/255 off from Blender 5.2's. Lights use Blender's units, measured with calibration renders (point and spot
P/4π, area P/(π·area)), so wattages from a Blender scene carry over unchanged.

## Install

```bash
git clone https://github.com/bendrape1-byte/js3d-broll ~/.claude/skills/js3d-broll
```

You need Node and a Remotion project with three.js; SKILL.md has the setup commands and the workflow (copy the
template, test a frame in a few seconds, render the clip).

## Contents

- `SKILL.md`: the instructions Claude follows.
- `template/DummyScene.tsx`: the dummy scene, a worked example to copy and change.
- `assets/agx_mhc_65.bin`: Blender's AgX + Medium High Contrast view as a 65³ lookup table.
- `scripts/`: the Blender scripts that baked the table and measured the light units. Only needed to re-measure.

Anatomy and other translucent materials have not been tried yet. Subsurface scattering is the part I would expect
to fall short of Cycles.
