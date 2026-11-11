---
name: js3d-broll
description: Lit 3D B-roll rendered in JavaScript (three.js inside the Remotion project) at near-Cycles quality in about a minute per clip instead of half an hour - figures like the crash-test dummy, props, objects, rooms, courts, and outdoor scenes lit by sun and sky (a garden with trees, grass, flowers, birds, a rabbit with fur) - as 1080x1920 (or 16:9) clips for a CapCut overlay. Soft shadows, depth of field, motion blur, glossy floor reflections and Blender's exact AgX colour. Use when an edit needs a 3D animation that is not anatomy (anatomy stays /anatomy-broll), when the user asks for 3D B-roll "in JavaScript" / "without Blender", or wants a Blender scene ported to JS.
---

# js3d-broll

Cycles traces random rays per pixel and averages them (~15 s per 1080x1920 frame on the M4). This skill rasterises
the whole frame with three.js 32 times and averages those passes; each pass picks one shutter time (motion blur), one
lens point (f/2 depth of field), one point on the key light's disk (soft shadows) and one sub-pixel offset (AA). Same
Monte Carlo idea, but one sample is a whole GPU frame, so a frame costs ~0.25 s.

Proven 2026-11-05 on REEL-33's dummy (`template/DummyScene.tsx`): the Blender scene ported line by line rendered in
49 s instead of 37 min 42 s, PSNR 31.2-33.0 dB per frame against Cycles' own PNGs, geometry aligned to the pixel.
Visible only side by side: no real bounce light (a static environment probe instead), so faces turned to the floor
are ~10-15/255 darker.

Built from scratch 2026-11-11 (`template/GardenScene.tsx`, no Blender original, no downloaded assets): a garden at
golden hour, 3.65 million triangles, 240 frames at 32 passes in 3 min 30 s (0.87 s per frame; a test frame 3-9 s).
That scene needed light, plants and fur the dummy never had; they are in the "Outdoor scenes" section below.

**Not for anatomy**: translucent tissue (subsurface scattering) and the Z-Anatomy meshes are untested here; use
/anatomy-broll (Ben wants anatomy to look like a medical render). Art direction as always: lit, moody 3D, never flat
(memory: B-roll art direction); for a new look show labelled variants first and insert only Ben's pick.

## Setup (once per machine)

The Remotion project `~/claude-code/animations` already has three.js and renders WebGL on the GPU
(`Config.setChromiumOpenGlRenderer("angle")` in remotion.config.ts). Copy the colour LUT in:

```bash
mkdir -p ~/claude-code/animations/public/js3d && cp ~/.claude/skills/js3d-broll/assets/agx_mhc_65.bin ~/claude-code/animations/public/js3d/
```

`GardenScene.tsx` imports the path tracer (its reference mode, see below) and the physics engine, so that template
needs three packages:

```bash
cd ~/claude-code/animations && npm i three-gpu-pathtracer@0.0.27 three-mesh-bvh && npm i --save-exact @dimforge/rapier3d-deterministic-compat@0.21.0
```

For outdoor scenes, a sky photo (23.8 MB, CC0; ask Ben before downloading, others are listed at polyhaven.com/hdris),
and for `scans: true` nine texture files from Poly Haven (18.6 MB: `bark_brown_02`, `rough_wood`, `concrete_floor_02`,
each as `_diff_2k.jpg`, `_nor_gl_2k.jpg`, `_rough_2k.jpg`; URLs from `api.polyhaven.com/files/<name>`) plus
`LeafSet004_1K-JPG_Color.jpg` and `_Opacity.jpg` from ambientcg.com (`get?file=LeafSet004_1K-JPG.zip`), all in
`public/js3d/`:

```bash
curl -L -o ~/claude-code/animations/public/js3d/spruit_sunrise_4k.hdr https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/spruit_sunrise_4k.hdr
```

Without that project (any other machine), make one; the paths below then start at its folder instead:

```bash
npx create-video@latest my-3d --blank && cd my-3d && npm i three @types/three   # tested: Remotion 4.0.542 + three r187
echo 'Config.setChromiumOpenGlRenderer("angle");' >> remotion.config.ts            # GPU WebGL in headless Chrome
mkdir -p public/js3d && cp ~/.claude/skills/js3d-broll/assets/agx_mhc_65.bin public/js3d/
```

## Make a clip

1. Pick the template nearer to the shot: `DummyScene.tsx` (studio or arena: spot + area lights, glossy floor, a posed
   figure) or `GardenScene.tsx` (outdoors: sun + sky, plants, animals, haze). Copy it to
   `~/claude-code/animations/src/<Client>/<Name>.tsx`, rename the export, register it in `src/Root.tsx` (`<Composition id=... durationInFrames fps={30} width={1080} height={1920} defaultProps={{ passes: 32 }} />`).
   Say so to Ben before touching Root.tsx; other sessions edit it too, so add lines, never rewrite it.
2. Replace the scene, keep the engine (map below). Time events to words in frames, like the dummy's touchdown on "3-5".
3. Test frames (8 passes is enough to judge pose and light, not depth of field; 3-8 s each with bundling):
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

## Outdoor scenes: what GardenScene.tsx adds

Engine (keep): `photoSky` / `paintedSky` + dome + `aim()` and the sun/sky block in the pass loop, `patch`, `Scatter`, `trans`, `fur`,
`tex`, `ribbon`, `limb`, `loft`, `paint`, the haze sheets, the lens (`LENS`, `aperture`, `handheld`, the output shader). Scene (replace): the
layout constants, `growTree`'s numbers, the animals and their keys, `CAM`.

- **Light it with a photographed sky** (prop `sky`, `photoSky(name, azimuth)`). An unclipped HDRI panorama
  (polyhaven.com, CC0, `public/js3d/<name>_4k.hdr`) is read as numbers, not just shown. The brightest spot and
  everything within 2.5 deg of it becomes the sun light: direction, colour and strength measured from the photo.
  The rest of the upper half is cut into 64 x 256 cells, and each pass picks one cell in proportion to its light, so
  every sample stands for the same amount and bright sky gets more samples. Sun against sky, and both colours, are
  then a real place's: warm sun, blue shade, which the painted gradient had wrong (2026-11-11, three photos side by
  side with the painted sky). `light` (2.6 on level ground) is the exposure. Checked: 32 samples add up to the sky's
  light on level ground within 3 % of the exact sum (8 samples: 7 %, 2048: 0.4 %), same on all three photos.
  Load as FloatType: the sun in these files reaches 68 000-254 000 and half floats stop at 65 504.
  `scripts/hdri_stats.mjs` prints a photo's sun height, sun share and colours (run it inside the Remotion project).
  `sky: ""` falls back to `paintedSky()` (no file needed, every direction equally likely, `skyRad`). Set the photo in
  the composition's `defaultProps` (`{ passes: 32, sky: "spruit_sunrise" }`, Ben's pick of three for the garden).
- **Scanned surfaces and leaf shapes** (prop `scans`). Bark, fence wood and stone are Poly Haven scans (colour,
  normal and roughness map, 2k JPG) on the same UVs as the generated textures: `scan(name, repeatX, repeatY,
  normalStrength)`. Around a branch the repeat must be a whole number or a seam shows. The bark needed normal
  strength 2.5 and one tile per trunk girth; at strength 1 and two tiles it read as smooth clay from 7 m.
  Leaves are cards cut out of a scanned leaf sheet (ambientCG LeafSet004: 6 leaves, colour + opacity): each
  instance picks one of the six rectangles (`LEAVES`, measured from the opacity mask), the mask discards the rest
  in the colour pass AND in the shadow pass (`customDepthMaterial`), and only the sheet's brightness is used
  (veins, blotches) so the colour stays the instance's own. Other leaf sheets need their own `LEAVES` and
  `LEAF_LUM`. In PLAIN mode the leaves fall back to the generated shape (a baked card would be a rectangle).
  Cost: the cut-out leaves doubled the clip's render time (240 frames: 188 s -> 401 s). A card covers about three
  times the area of the old leaf shape and every fragment of it reads the mask, in two shadow passes and the picture.
- **Physics is simulated once and stored** (`@dimforge/rapier3d-deterministic-compat`, the block before the
  animation in `build`). Rapier steps the world at 240 Hz from `PRE` = 4 s before frame 0 (so whatever hangs is
  already swinging) to the end of the clip; every body's position and rotation is kept 120 times a second, and a
  frame only looks its moment up (`play(track, t)`, interpolated). Frames stay a pure function of the frame number,
  Remotion may still render them in any order, and sub-frame times still motion-blur. Never step the world per frame.
  - Colliders come from the meshes themselves (`solidMesh`: lawn patch, stones, bird bath as triangle meshes), in
    Blender coordinates with gravity on -Z. Rapier's capsules lie along Y: rotate them (`UPQ`) to stand up.
  - A body that lets go later (an apple at 1.5 s) is created at that step; until then its track holds the rest pose.
  - Something on a cord = two bodies on ball joints (cord + load), the cord with collision groups 0 so it only
    weighs. Drive it with a force, not with keys. Keep the forcing away from the pendulum's own frequency
    (sqrt(g / length), 3.2 rad/s for 0.94 m): with part of the wind at 2.9 rad/s the bird house swung +-16 deg; with
    that part moved to 4.7 rad/s and the force cut by a third it swings +-5 deg (both read from the stored track).
  - Read the stored tracks out before rendering (where each body ends, when it first bounces): the first apple lands
    beside the rabbit at frame 69, so the rabbit's keys got a startle there. Physics gives the event, keys react to it.
  - Cost: 0.1 s at build for this scene (5 bodies, 12 s at 240 Hz). The render time does not change.
- **Sunset photos have a very low sun** (8-12 deg in the three tested; a 1.5 m fence throws 10 m). `SUN_AZ` turns the
  photo so its sun comes in where nothing blocks it: 70 deg (from the right) for the garden.
- **Sky light with real occlusion.** Besides the sun, every pass adds ONE more shadow-casting directional light from
  a sky direction (`sky.pick(i)`), coloured by the sky there.
  The mean of the passes is the integral over the sky, and because each sample has its own shadow map
  the result is darker under bushes, between blades and under an animal: ambient occlusion that is measured, not
  faked. A HemisphereLight with a black sky colour adds only the lawn's bounce from below. No environment map on
  diffuse materials (it would count the sky twice); the PMREM of the dome goes on glossy things only (eyes, water).
- **Shadow maps are fitted every pass.** `aim(light, direction)` projects the garden's bounding box into the light's
  view and sets the orthographic frustum from it (sun 8192, sky 4096). The box must hold every caster whose shadow
  reaches the frame; with a low sun that is far more than the frame (a 4 m crown throws 10 m).
- **Plants are one mechanism: `Scatter`.** An InstancedBufferGeometry with our own per-instance attributes
  (position, quaternion, scale, colour, volume normal, random), composed in `begin_vertex`. Not three's
  InstancedMesh: its instance matrix is applied after `begin_vertex`, so wind could not move the final point. This
  way every later chunk (projection, world position, shadow lookup) sees the finished vertex, and the same patch on
  `customDepthMaterial` makes the shadows sway too. The garden holds 189 000 blades and 149 000 leaves this way.
- **Foliage shading.** A lawn of correctly shaded blades looks like noise. Each instance carries a "volume normal"
  (lawn: up; crown and bush: outward from the centre) and the leaf normal is blended towards it (`nb`), with the
  DOUBLE_SIDED normal flip removed. Light from behind is added inside `RE_Direct_Physical` (`trans`: backlit leaves,
  grass, wings and fur glow, and still take shadows). Blades get darker towards the foot (`root`).
- **Wind** is a function of position and `uTime`, and `uTime` is the pass's own sub-frame time, so it motion-blurs.
  Wood and leaves read the same `sway()` field, so leaves stay on their twigs without any rig.
- **Fur = shells** (`fur()`): the painted mesh drawn 18 times as instances, each pushed further out along the normal
  and combed back; a 3D hash of the skin point decides per cell how long the strand is and discards the rest.
  Per-vertex `furLen` keeps eyes and paws clear. Shell spacing must stay under 1 px or the layers show as contour
  lines at the silhouette. Fur also hides the seams between rigid parts (head, ears, body are separate meshes).
- **Animals** are lofts from a side view (`loft`: rows of y, z, half width, half height), painted per vertex
  (`paint`), moved as rigid groups with stepped spline keys. Birds move in jerks: hold a pose, change it in 3 frames.
- **Trees**: a leader that tapers to a tip with side branches along its upper part, each turned ~137 deg from the
  last and shorter the higher it sits; twigs under 2 cm carry the leaves. Forking only at the tip of each branch
  (the first attempt) gives a candelabra.
- **Haze and light shafts**: 28 camera-facing sheets of additive Lambert "air" whose normal is forced to the sun and
  which receive shadows. Summed, the air is lit except in the crown's shadow. Their depths shift every pass.
- **Look**: the painted dome is drawn 0.62x darker than it lights (a white sky otherwise), a photo as it is; glow = 8 % of the frame's own mip
  chain; FogExp2 for the far distance. Corner darkening and noise are the lens's (next section).

## The lens (GardenScene.tsx)

An ideal thin lens and a clean sensor are the last things that say "render". `LENS` at the top of the file holds
one number per flaw of a real camera, 0 = off; `plain` and `pt` run with all of them off. Try a value without
editing the file: `--props='{"passes":32,"sky":"spruit_sunrise","scans":true,"lens":{"fringe":4}}'`.

`LENS = { fstop: 2, blades: 7, squeeze: 1, distort: 0.02, fringe: 1, noise: 0.02, falloff: 1, shake: 1 }` was picked
2026-11-11 from labelled variants on the restrained side: a good real lens, not an effect. The clip with it is
`out/garden_lens.mp4` (240 frames in 6 min 46 s against 6 min 38 s for the clip before: the lens costs next to nothing).

- **Aperture shape** (`aperture(u, v, blades, squeeze)`, in the pass loop). The lens point of a pass is drawn from a
  polygon instead of a disk: the polygon is `blades` triangles around the centre, `v` picks a triangle and a place
  along its outer edge, `sqrt(u)` the way out, which spreads the points evenly. `squeeze` scales the aperture's width
  (0.5 = an anamorphic lens's tall oval). Checked: 20 000 points, none outside the heptagon, centroid 0.0000.
- **Barrel distortion and colour fringing** (output shader). The finished frame is read back at
  `q * (1 + distort * r2) / (1 + distort)`, r2 = 0 in the middle and 1 in the corners: the corners keep their place
  and the middle grows by `distort`, so no border has to be invented. Red is read `fringe` pixels further out at the
  corners and blue as far in, green stays (lateral chromatic aberration).
- **Natural fall-off** replaces the hand-set vignette: `cos^4` of each pixel's angle off the lens axis, from the real
  focal length (`uTan`). At 27 mm on the 24 mm tall sensor that is 0.70 at the top edge and 0.63 in the corners (the
  old vignette: 0.875 and 0.75).
- **Sensor noise** replaces the grain. It is added in linear light before the LUT, per colour channel, with a spread
  of `noise * sqrt(0.18 * c)`: photons arrive at random, so the spread grows with the root of the light, and `noise`
  is its share of the signal at mid grey. On screen it therefore comes out like a camera's, strongest in the dark
  and fading in the highlights (measured at 4 %, sd of noisy minus clean in G/255: 2.4-2.7 below 128, 1.2 at 160-191,
  0.8 above 192; fence 2.6, sky 1.2; at the default 2 %: fence 1.4, sky 0.7). The old grain was 1.0 everywhere.
  Seeded by the frame number.
- **Handheld** (`handheld(t, shake)`, added to the camera in `update`). Position, aim and roll each get a slow sway
  (two sines under 0.6 Hz) plus a tremor at 5 % of it (2-5 Hz), all with unrelated periods. It is a pure function of
  time, so frames stay order-independent and every pass's sub-frame time blurs it. Measured from the scene with a
  probe (project a near and a far point through the camera for all 240 frames, with `shake` 1 and 0): the picture
  wanders +-13 px (1.2 % of the width), at most 1.2 px per frame for a far point, and that speed changes by at most
  0.44 px from one frame to the next; roll -0.12 to +0.37 deg; the camera itself moves +-6 mm. For comparison the
  steady camera path alone moves the rabbit 0.5 px per frame.

What the test frames showed (frame 150, each flaw alone against the same frame without it):

- **The blade count cannot be seen at f/2 in this shot.** The background blur is at most ~10 px across and a pass
  is one sharp copy, so 32 points on a disk, a heptagon or a pentagon look the same. Control: at `fstop` 0.5 and 256
  passes the midges in the sun turn into clean disks, pentagons or tall ovals, so the sampling is right. Blades are
  worth choosing only when the blur is tens of pixels wide and there are small bright things in it. The oval does
  show at f/2: half the sideways blur (the foreground grass is visibly sharper across).
- Do not judge the aperture shape by a difference picture: another shape moves all 32 lens points, and that alone
  changes the frame by 2.4/255 on average.
- Distortion is almost invisible in a scene without straight lines near the edges; at these strengths it reads as
  the middle being a little larger.
- **Reading the frame back between its pixels costs sharpness, whatever the strength.** With the GPU's bilinear
  filter 2 % distortion took 28 % of the fine detail (mean edge strength on the rabbit and grass, native pixels:
  34.2 -> 24.6; 8 % distortion: 23.9, so it is the resampling, not the amount), and 2 px fringing took 13 %. The
  output shader therefore reads through a 4 x 4 Catmull-Rom curve (`sharp()`): 29.7 with 2 % distortion, 29.3 with
  the defaults, and with distortion and fringing at 0 the frame is the old one to 1/255. The 13 % that is left is
  the price of any distortion at 1080 px; set `distort` and `fringe` to 0 when a shot needs every pixel.
- Fringing shows only where a dark edge meets the sky near a corner: 1 px is hard to find, 2 px is there when you
  look for it, 4 px reads as a cheap lens.
- Keep the tremor under ~5 Hz. The first version had it at 4-9 Hz: at 30 fps the picture then stepped 1.6 px, 0.3 px,
  1.6 px on alternate frames (speed changing by 1.4 px between frames), which is judder, not a hand. Found by
  probing the path, confirmed in a rendered clip (largest step in the frame-to-frame difference 2.35 against 0.85
  after the change). Judge handheld motion from the probed path and a clip, never from a still.
- A full clip check after any camera change: 240 frames, no audio track, no magenta frame, and the frame-to-frame
  difference at quarter size without an outlier (here max / median 1.40, and it follows the probed camera speed,
  r = 0.83).

## A reference inside JS: path-trace the same scene

`three-gpu-pathtracer` traces the scene in the same headless Chrome: every bounce, no shadow maps. It is the judge,
not the renderer: on the garden (3.69 M triangles) a sample takes 1.35 s, so 64 samples = 100 s, 256 = 6 min, and the
240-frame clip at 256 samples would take 24 h. Use it for single reference frames.

```bash
cd ~/claude-code/animations   # the tracer is 0.0.27 on purpose: 0.0.28 needs three >= 0.187
npx remotion still src/index.ts <Id> ref.png --frame=150 --props='{"sky":"spruit_sunrise","pt":256}' --timeout=1200000
npx remotion still src/index.ts <Id> ours.png --frame=150 --props='{"sky":"spruit_sunrise","plain":true}'
python3 ~/.claude/skills/js3d-broll/scripts/compare.py ref.png ours.png   # PSNR at quarter size + mean colour of named boxes (edit them)
```

- `pt` and `plain` both render the PLAIN scene: instances baked to real triangles (`Scatter.baked`), no wind, no
  light through leaves, no fur shells, no haze, no lens. The tracer runs none of our shaders, so the comparison
  measures light transport only. It cannot judge the full look.
- Garden, frame 150, 2026-11-11: ours against the 256-sample reference 27.9 dB, whole frame within 2/255 (control:
  the same frame shifted 8 px = 16.9 dB; noise floor, 64 against 256 samples = 42.4 dB). What it found:
  - Shadow `normalBias` was 1.2 cm, wider than a 5 mm blade, so every blade read its neighbour's shadow and the
    lawn was 12/255 too dark. 1.5 mm fixed it (25.0 -> 27.9 dB). Keep it under the thinnest thing in the scene.
  - More shadow-map resolution changed nothing (16384 + 8192: 24.8 dB). Do not spend time there.
  - The HemisphereLight standing in for ground bounce is needed and about right: without it 24.1 dB, frame 6/255 dark.
  - The trunk stays 10/255 too bright; 6 of that is the bark bump map, which the tracer ignores.
- What the tracer needed (each one cost a black or wrong frame):
  - It stores the sky as half floats, so a sun above 65 504 is clipped and the light turns cold. Hand it a dimmed
    copy of the photo and raise `environmentIntensity` by the same factor.
  - 0.0.27 drops 3-component vertex colours when it merges meshes (black): convert them to 4 components.
  - A mirrored copy (negative scale) needs its triangles reversed when baked, or facing and normal disagree (black).
    Our own renderer hides that mistake.
  - It compiles and renders asynchronously: loop `renderSample()` with an `await` in between until `samples` is
    reached, `renderDelay = 0`, `renderToCanvas = false`, then put its `target` through our LUT stage.
  - Its sheen is far stronger than three's (the blackbird came out grey) and it has no bump maps.
  - `WebGLPathTracer` is marked deprecated in favour of a WebGPU one; pin the version.

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

- One `onBeforeCompile` function serving several variants (closure parameters) needs `customProgramCacheKey`:
  three caches the program by the function's source text and silently reuses the first variant for all.
- `vertexColors: true` on a geometry without a `color` attribute renders black. No warning.
- A JS number pasted into GLSL must be a float literal (`x.toFixed(5)`): `vBase * 700` does not compile.
- Internal shader names change between three versions (r185: `material.diffuseContribution`, not `diffuseColor`).
  Grep the chunk in `node_modules/three/src/renderers/shaders/ShaderChunk/` before patching it.
- Never run two renders at once. Headless Chrome then shows the WebGL canvas as solid magenta (255, 0, 255) although
  the pixels in it are right; the same happens after the path tracer has run. `trace()` reads the pixels back with
  `gl.readPixels` and shows them on a 2D canvas; a normal render just has to run alone.
- The template packs several statements on a line. A `//` comment added in the middle of one silently removes the
  rest: that is how `scene.add(light)` vanished once and the frame went almost black. Comments at line ends only.
- Depth of field needs passes: each pass is one sharp copy of the scene, so few passes show a blur as ghost copies.
  f/1.4 at 8 passes (crown ~12 px out of focus) smeared the whole tree; f/2 at 16-32 passes was clean. Judge blur
  at 32 passes, not on the 8-pass test frames.

- `remotion still` does not print the browser console: a shader that fails to compile shows up only as a missing or
  black object. Two `onBeforeCompile` injections declaring the same variable name in `main()` did exactly that.
  GardenScene.tsx sets `renderer.debug.onShaderError` to throw the compile log, which `cancelRender` then prints.
- Comparing against a Blender clip: use its PNG frames, not the CapCut MP4 (bt709 tv-range re-encode). SSIM is
  useless on these dark frames (an MP4 against its own PNG scores 0.83); use PSNR at quarter size, mean colour of
  named regions, and edge registration with a planted-shift control for geometry.
- A screen-space reflection only contains what its camera sees; that is why its FOV is doubled.
