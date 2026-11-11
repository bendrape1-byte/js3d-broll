---
name: js3d-broll
description: Lit 3D B-roll rendered in JavaScript (three.js inside the Remotion project) at near-Cycles quality in about a minute per clip instead of half an hour - figures like the crash-test dummy, props, objects, rooms, courts - as 1080x1920 (or 16:9) clips for a CapCut overlay. Soft shadows, depth of field, motion blur, glossy floor reflections and Blender's exact AgX colour. Use when an edit needs a 3D animation that is not anatomy (anatomy stays /anatomy-broll), when the user asks for 3D B-roll "in JavaScript" / "without Blender", or wants a Blender scene ported to JS.
---

# js3d-broll

Cycles traces random rays per pixel and averages them (~15 s per 1080x1920 frame on the M4). This skill rasterises
the whole frame with three.js 32 times and averages those passes; each pass picks one shutter time (motion blur), one
lens point (f/2 depth of field), one point on the key light's disk (soft shadows) and one sub-pixel offset (AA). Same
Monte Carlo idea, but one sample is a whole GPU frame, so a frame costs ~0.25 s.

Proven 2026-11-05 on REEL-33's dummy (`template/DummyScene.tsx`): the Blender scene ported line by line rendered in
49 s instead of 37 min 42 s, PSNR 31.2-33.0 dB per frame against Cycles' own PNGs, geometry aligned to the pixel.
Visible only side by side: no real bounce light (a static environment probe instead), so faces turned to the floor
are ~10-15/255 darker. Not yet used for a scene built from scratch.

**Not for anatomy**: translucent tissue (subsurface scattering) and the Z-Anatomy meshes are untested here; use
/anatomy-broll (Ben wants anatomy to look like a medical render). Art direction as always: lit, moody 3D, never flat
(memory: B-roll art direction); for a new look show labelled variants first and insert only Ben's pick.

## Setup (once per machine)

The Remotion project `~/claude-code/animations` already has three.js and renders WebGL on the GPU
(`Config.setChromiumOpenGlRenderer("angle")` in remotion.config.ts). Copy the colour LUT in:

```bash
mkdir -p ~/claude-code/animations/public/js3d && cp ~/.claude/skills/js3d-broll/assets/agx_mhc_65.bin ~/claude-code/animations/public/js3d/
```

Without that project (any other machine), make one; the paths below then start at its folder instead:

```bash
npx create-video@latest my-3d --blank && cd my-3d && npm i three @types/three   # tested: Remotion 4.0.542 + three r187
echo 'Config.setChromiumOpenGlRenderer("angle");' >> remotion.config.ts            # GPU WebGL in headless Chrome
mkdir -p public/js3d && cp ~/.claude/skills/js3d-broll/assets/agx_mhc_65.bin public/js3d/
```

## Make a clip

1. Copy `template/DummyScene.tsx` to `~/claude-code/animations/src/<Client>/<Name>.tsx`, rename the export, register
   it in `src/Root.tsx` (`<Composition id=... durationInFrames fps={30} width={1080} height={1920} defaultProps={{ passes: 32 }} />`).
   Say so to Ben before touching Root.tsx; other sessions edit it too, so add lines, never rewrite it.
2. Replace the scene, keep the engine (map below). Time events to words in frames, like the dummy's touchdown on "3-5".
3. Test frames (8 passes is enough to judge pose and light; ~8 s each with bundling):
   `npx remotion still src/index.ts <Id> /tmp/f60.png --frame=60 --props='{"passes":8}'` - look at them.
4. Render: `npx remotion render src/index.ts <Id> out.mp4 --image-format=png --concurrency=1` (~50 s for 150 frames),
   then drop Remotion's silent audio: `ffmpeg -i out.mp4 -an -c:v copy clip.mp4`.
5. Put it in as a full-frame overlay (capcut `format.md`: Adding a video or image overlay) on its slot.

Frames are a pure function of the frame number (fixed Halton samples per pass): two renders are bit-identical, and
Remotion may render frames in any order or in parallel tabs. Never carry state from one frame to the next.

## The template: engine vs scene

Engine (keep): `rotA/mm/mv/frame/spline` (mathutils equivalents, so Blender maths ports 1:1), `ring` +
`catmullClark` + `solid/vseg/yseg/tube` (shells from profile rings, subdivided twice like a Subsurf modifier), `mat`
(Principled -> MeshPhysical: lin colour, roughness, clearcoat 0.12), the floor shader (wood + planar reflection), the
lights block, the environment probe, render targets, `mirror()`, the per-pass loop and the LUT output quad.
Scene (replace): the dummy (`LEFT`, `BONES`, profiles, `Rig`), its motion (`mainPose`, `standPose`, keys), the court
canvas, hoop and arena, the camera keys `CAM` and the fx (rings, flash, heat glow).

Coordinates: everything sits in `root`, a group turned -90 deg about X, so positions are Blender's (Z up); convert
single points with `b2t()` for things outside `root` (camera, area lights). Lens: vertical sensor 24 mm,
`fov = 2 atan(12 / lens)`. Focus: `focus` = distance to the subject along the view.

## Measured facts (do not re-derive)

- Colour: Blender 5.2's AgX is not three.js's `AgXToneMapping` (grey 0.18 -> 118 vs 128, up to 48/255 off). The
  output quad applies Blender's own AgX + "Medium High Contrast" from `agx_mhc_65.bin` (65^3, log2 shaper over
  [-12.47393, +4.026069]); max error 1.4/255. Re-bake with `scripts/bake_lut.py` if Blender's view changes.
- Light units = Cycles' (checked with `scripts/light_units.py`): point/spot intensity `P / 4pi`, area radiance
  `P / (pi * area)` (a RectAreaLight's intensity). Spot blend 0.65 = three.js penumbra 0.41 (`scripts/spot_falloff.py`,
  rms 0.004). So Blender wattages carry over unchanged.
- Shadows come only from the key spot, softened by moving it over its radius each pass. RectAreaLights cast none.
- Glossy floor: one planar reflection per pass (camera mirrored, FOV x2 so lights outside the frame still reflect),
  lights drawn into it as emitter quads so bodies block them. Blur radius from the reflection's depth (near things
  sharp, far things soft), lobe 2a along the view and 2a*cos across, 50/40/10 % at 1x/3x/10x for GGX tails. A coat
  (0.55, roughness 0.07) and a rough base (0.3) both read from it.
- Emission (glows, rings) is plain radiance: `emissive` / MeshBasicMaterial colour above 1 is fine (half-float targets).

## Pitfalls

- `remotion still` does not print the browser console: a shader that fails to compile shows up only as a missing or
  black object. Two `onBeforeCompile` injections declaring the same variable name in `main()` did exactly that.
- Comparing against a Blender clip: use its PNG frames, not the CapCut MP4 (bt709 tv-range re-encode). SSIM is
  useless on these dark frames (an MP4 against its own PNG scores 0.83); use PSNR at quarter size, mean colour of
  named regions, and edge registration with a planted-shift control for geometry.
- A screen-space reflection only contains what its camera sees; that is why its FOV is doubled.
