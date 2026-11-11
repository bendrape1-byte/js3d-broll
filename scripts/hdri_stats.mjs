// Measures a sky photo: sun direction, sun's share of the light on level ground, colours.  node hdri_stats.mjs a.hdr b.hdr
import fs from "fs";
import * as THREE from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f), t = new HDRLoader().setDataType(THREE.FloatType).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const { width: W, height: H, data: D } = t, n = D.length / (W * H);
  let max = 0, mi = 0, mj = 0;
  for (let j = 0; j < H / 2; j++) for (let i = 0; i < W; i++) { const k = (j * W + i) * n, y = 0.2126 * D[k] + 0.7152 * D[k + 1] + 0.0722 * D[k + 2]; if (y > max) { max = y; mi = i; mj = j; } }
  const dirOf = (i, j) => { const e = Math.PI / 2 - (Math.PI * (j + 0.5)) / H, p = (2 * Math.PI * (i + 0.5)) / W - Math.PI; return [Math.cos(e) * Math.sin(p), Math.cos(e) * Math.cos(p), Math.sin(e)]; };
  const s0 = dirOf(mi, mj), cosR = Math.cos((2.5 * Math.PI) / 180);        // sun = everything within 2.5 deg of the brightest pixel
  const E = { sun: [0, 0, 0], sky: [0, 0, 0] }; let sd = [0, 0, 0], sw = 0, skyY = 0, skyW = 0;
  for (let j = 0; j < H / 2; j++) {
    const e = Math.PI / 2 - (Math.PI * (j + 0.5)) / H, dw = Math.cos(e) * (Math.PI / H) * ((2 * Math.PI) / W);
    for (let i = 0; i < W; i++) {
      const k = (j * W + i) * n, d = dirOf(i, j), isSun = d[0] * s0[0] + d[1] * s0[1] + d[2] * s0[2] > cosR, y = 0.2126 * D[k] + 0.7152 * D[k + 1] + 0.0722 * D[k + 2];
      for (let c = 0; c < 3; c++) E[isSun ? "sun" : "sky"][c] += D[k + c] * d[2] * dw;      // irradiance on level ground
      if (isSun) { for (let c = 0; c < 3; c++) sd[c] += d[c] * y * dw; sw += y * dw; } else { skyY += y * dw; skyW += dw; }
    }
  }
  const L = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], nrm = Math.hypot(...sd), r = (x) => +x.toFixed(3);
  sd = sd.map((x) => x / nrm);
  console.log(f.split("/").pop(), `${W}x${H} comps ${n} max ${r(max)}`);
  console.log("  sun: elevation", r((Math.asin(sd[2]) * 180) / Math.PI), "deg, azimuth", r((Math.atan2(sd[0], sd[1]) * 180) / Math.PI), "deg from image centre");
  console.log("  level-ground light: sun", E.sun.map(r), "sky", E.sky.map(r), "-> sun share", r(L(E.sun) / (L(E.sun) + L(E.sky))));
  console.log("  sun colour (norm)", E.sun.map((x) => r(x / Math.max(...E.sun))), "sky colour (norm)", E.sky.map((x) => r(x / Math.max(...E.sky))), "mean sky luminance", r(skyY / skyW));
}
