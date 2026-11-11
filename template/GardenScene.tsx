import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { AbsoluteFill, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";

// js3d-broll, outdoor worked example: a garden at golden hour, built from nothing (no Blender original, no assets).
// Same idea as DummyScene.tsx (a frame = the mean of `passes` rasterised renders, Blender's AgX on the way out), but
// the light is the open sky instead of an arena:
//   - sun: one directional light, jittered over a small disk each pass (soft shadows)
//   - sky: each pass ONE more shadow-casting directional light from a random sky direction, coloured by the sky there.
//     The mean over the passes is sky light with real occlusion (dark under bushes, in the grass, under the rabbit).
//   - plants: one instancing patch (Scatter) for blades, leaves, petals; light shines through them (trans)
//   - fur: shells (the mesh drawn 18 times, pushed out along the normal, strands cut out by a 3D hash)
// Everything is in Blender's Z-up coordinates inside `root`. A frame is a pure function of the frame number.

const W = 1080, H = 1920;
type V3 = THREE.Vector3;
type Key = [number, number[]];
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1);
const rad = (d: number) => (d * Math.PI) / 180;
const sm = (x: number) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };
const lin = (c: number[]) => c.map((x) => x ** 2.2);
const mix = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i] - x) * t);
const col = (c: number[], k = 1) => new THREE.Color().setRGB(c[0] * k, c[1] * k, c[2] * k, THREE.LinearSRGBColorSpace);
const b2t = (v: V3) => V(v.x, v.z, -v.y);   // Blender (Z up) -> three (Y up), same as the root group's turn
const fl = (x: number) => x.toFixed(5);     // a JS number as a GLSL float literal ("700" would be an int)
const v3 = (c: number[]) => `vec3(${c.map(fl).join(", ")})`;
const TAU = 2 * Math.PI;
function rng(seed: number) {                // mulberry32: the scene must come out the same on every build
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PN = new ImprovedNoise();
const fbm = (x: number, y: number, z = 0.37, oct = 4) => { let s = 0, a = 0.5; for (let i = 0; i < oct; i++) { s += a * PN.noise(x, y, z); x *= 2; y *= 2; z *= 2; a *= 0.5; } return s; };
function spline(t: number, ks: Key[]): number[] {   // cubic through the keys, Catmull-Rom tangents, flat at both ends
  const n = ks.length, ts = ks.map((k) => k[0]), vs = ks.map((k) => k[1]);
  if (t <= ts[0]) return vs[0].slice();
  if (t >= ts[n - 1]) return vs[n - 1].slice();
  let i = 0;
  while (ts[i + 1] <= t) i++;
  const h = ts[i + 1] - ts[i], u = (t - ts[i]) / h;
  const m = (j: number) => vs[j].map((_, k) => (j === 0 || j === n - 1 ? 0 : (vs[j + 1][k] - vs[j - 1][k]) / (ts[j + 1] - ts[j - 1])));
  const m0 = m(i), m1 = m(i + 1);
  return vs[i].map((v0, k) => (2 * u ** 3 - 3 * u ** 2 + 1) * v0 + (u ** 3 - 2 * u ** 2 + u) * h * m0[k]
    + (-2 * u ** 3 + 3 * u ** 2) * vs[i + 1][k] + (u ** 3 - u ** 2) * h * m1[k]);
}
const halton = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const QUAD_VS = "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";

// ---------------------------------------------------------------- layout (metres, camera looks along +Y)
const SUN = V(0.55, 0.75, 0.38).normalize();        // direction to the sun: behind the tree, to the right, 22 deg up
const TREE = V(-0.6, 1.8, 0), RABBIT = V(0.25, -1.5, 0), BATH = V(0.85, -0.1, 0);
const STONES = [[-0.85, -3.3, 0.3], [-0.72, -2.65, 0.26], [-0.44, -2.05, 0.27], [-0.62, -1.35, 0.25], [-0.34, -0.7, 0.28], [0.1, -0.15, 0.24]];
const BUSHES = [[-1.9, 4.9, 0.95, 0.75, 0.9], [1.75, 3.7, 0.75, 0.7, 0.7], [0.25, 5.25, 0.45, 0.45, 0.42]];   // x, y, rx, ry, rz
const HEDGE = [[-5.6, 7.9, 2.5], [-3.3, 8.3, 3.0], [-1.0, 7.8, 2.3], [1.2, 8.4, 2.8], [3.5, 7.9, 2.4], [5.8, 8.2, 2.9]];   // x, y, height
const FENCE_Y = 6.0, HAZE = 0.012;                      // HAZE: how much sunlight a sheet of air (0.5 m) throws back
const gz = (x: number, y: number) => 0.05 * PN.noise(x * 0.35 + 3.1, y * 0.35, 0.5) + 0.012 * PN.noise(x * 1.9, y * 1.9 + 7.7, 0.5);
const G = (x: number, y: number, z = 0) => V(x, y, gz(x, y) + z);
const HOR = [0.54, 0.41, 0.28], ZEN = [0.08, 0.17, 0.42];
function skyRad(d: V3) {                            // the sky's radiance in a direction (the dome's shader below is the same, plus clouds)
  const mu = Math.max(d.dot(SUN), 0), t = Math.max(d.z, 0) ** 0.45, g = 1.1 * mu ** 6;
  return [HOR[0] + (ZEN[0] - HOR[0]) * t + 1.5 * g, HOR[1] + (ZEN[1] - HOR[1]) * t + 0.95 * g, HOR[2] + (ZEN[2] - HOR[2]) * t + 0.5 * g];
}
const SKY_FS = `varying vec3 vD;
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vD); float mu = max(dot(d, ${v3(SUN.toArray())}), 0.0), t = pow(max(d.z, 0.0), 0.45), g = 1.1 * pow(mu, 6.0) + 14.0 * pow(mu, 90.0);
  vec3 c = mix(${v3(HOR)}, ${v3(ZEN)}, t) + vec3(1.5, 0.95, 0.5) * g;
  vec2 q = d.xy / (d.z + 0.12);
  float cl = smoothstep(0.47, 0.62, fbm(vec3(q * vec2(1.3, 3.0) + 3.0, 1.7))) * smoothstep(0.03, 0.2, d.z);
  c = mix(c, vec3(0.34, 0.30, 0.33) + vec3(1.5, 0.85, 0.5) * (0.25 + 1.6 * pow(mu, 2.0)), 0.75 * cl);   // clouds: grey bodies, lit warm towards the sun
  gl_FragColor = vec4(d.z < 0.0 ? vec3(0.03, 0.04, 0.015) : c * 0.62, 1.0);   // seen a stop darker than it lights (a graduated filter): colour instead of white
}`;

// ---------------------------------------------------------------- geometry
function ring(c: V3, u: V3, v: V3, ru: number, rv: number, n = 20, p = 2.0): V3[] {
  const s = (x: number) => Math.sign(x) * Math.abs(x) ** (2 / p);
  return Array.from({ length: n }, (_, i) => { const a = (TAU * i) / n; return c.clone().addScaledVector(u, s(Math.cos(a)) * ru).addScaledVector(v, s(Math.sin(a)) * rv); });
}
function catmullClark(P: number[][], F: number[][]): [number[][], number[][]] {   // closed meshes only
  const nv = P.length;
  const avg = (q: number[][]) => [0, 1, 2].map((k) => q.reduce((s, p) => s + p[k], 0) / q.length);
  const fp = F.map((f) => avg(f.map((i) => P[i])));
  const key = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);
  const E = new Map<number, { a: number; b: number; f: number[]; i: number }>();
  F.forEach((f, fi) => f.forEach((a, k) => { const b = f[(k + 1) % f.length], e = E.get(key(a, b)); if (e) e.f.push(fi); else E.set(key(a, b), { a, b, f: [fi], i: 0 }); }));
  const edges = [...E.values()];
  const ep = edges.map((e, j) => { e.i = nv + j; return avg([P[e.a], P[e.b], fp[e.f[0]], fp[e.f[1] ?? e.f[0]]]); });
  const Q = P.map(() => [0, 0, 0]), R = P.map(() => [0, 0, 0]), nf = new Array(nv).fill(0), ne = new Array(nv).fill(0);
  F.forEach((f, fi) => f.forEach((i) => { for (let k = 0; k < 3; k++) Q[i][k] += fp[fi][k]; nf[i]++; }));
  for (const e of edges) for (const i of [e.a, e.b]) { for (let k = 0; k < 3; k++) R[i][k] += (P[e.a][k] + P[e.b][k]) / 2; ne[i]++; }
  const vp = P.map((p, i) => [0, 1, 2].map((k) => (Q[i][k] / nf[i] + (2 * R[i][k]) / ne[i] + (ne[i] - 3) * p[k]) / ne[i]));
  const f0 = nv + edges.length, NF: number[][] = [];
  F.forEach((f, fi) => f.forEach((v, k) => { const nx = f[(k + 1) % f.length], pv = f[(k + f.length - 1) % f.length]; NF.push([v, E.get(key(v, nx))!.i, f0 + fi, E.get(key(pv, v))!.i]); }));
  return [[...vp, ...ep, ...fp], NF];
}
function solid(rings: V3[][], poles: V3[], sub = 2) {   // a closed shell through the rings, subdivided like a Subsurf modifier
  const n = rings[0].length, last = (rings.length - 1) * n, p0 = rings.length * n;
  let P = [...rings.flat(), ...poles].map((q) => [q.x, q.y, q.z]);
  let F: number[][] = [];
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < n; i++) { const j = (i + 1) % n; F.push([r * n + i, r * n + j, (r + 1) * n + j, (r + 1) * n + i]); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; F.push([j, i, p0], [last + i, last + j, p0 + 1]); }
  let vol = 0;
  const A = (a: number[]) => V(a[0], a[1], a[2]);
  for (const f of F) for (let k = 1; k < f.length - 1; k++) vol += A(P[f[0]]).dot(A(P[f[k]]).cross(A(P[f[k + 1]])));
  if (vol < 0) F = F.map((f) => f.slice().reverse());
  for (let s = 0; s < sub; s++) [P, F] = catmullClark(P, F);
  const idx: number[] = [];
  for (const f of F) for (let k = 1; k < f.length - 1; k++) idx.push(f[0], f[k], f[k + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P.flat(), 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** A symmetric body from its side view: rows [y, z, rx, rv] along a spine in the YZ plane (rx = half width, rv = half height). */
function loft(prof: number[][], n = 20, p = 2.0, sub = 2) {
  const pts = prof.map((q) => V(0, q[0], q[1]));
  const rings = prof.map((q, i) => {
    const d = pts[Math.min(i + 1, pts.length - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize();
    return ring(pts[i], X, d.clone().cross(X), q[2], q[3], n, p);
  });
  const e = pts.length - 1, d0 = pts[1].clone().sub(pts[0]).normalize(), d1 = pts[e].clone().sub(pts[e - 1]).normalize();
  return solid(rings, [pts[0].clone().addScaledVector(d0, -prof[0][3] * 0.8), pts[e].clone().addScaledVector(d1, prof[e][3] * 0.8)], sub);
}
const bare = (g: THREE.BufferGeometry) => { g.deleteAttribute("uv"); return g; };
const ell = (c: V3, rx: number, ry: number, rz: number) => bare(new THREE.SphereGeometry(1, 20, 14).scale(rx, ry, rz).translate(c.x, c.y, c.z));
const stick = (a: V3, b: V3, r: number, r2 = r, n = 6) => {
  const g = new THREE.CylinderGeometry(r2, r, a.distanceTo(b), n, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize())).translate(...a.clone().lerp(b, 0.5).toArray());
  return bare(g);
};
/** Vertex colours (linear) and, for fur, each vertex's hair length 0..1: f(position) -> [r, g, b, len]. */
function paint(g: THREE.BufferGeometry, f: (p: V3) => number[]) {
  const P = g.attributes.position, c = new Float32Array(P.count * 3), l = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) { const q = f(V(P.getX(i), P.getY(i), P.getZ(i))); c.set(q.slice(0, 3), i * 3); l[i] = q[3] ?? 1; }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3)); g.setAttribute("furLen", new THREE.BufferAttribute(l, 1));
  return g;
}
/** A leaf, blade or petal along +Y (length 1), face +Z: rows [y, half width]; fold lifts the edges, bend curls it in Z. */
function ribbon(rows: number[][], fold = 0, bend = 0, mid = true) {
  const P: number[] = [], I: number[] = [], at: number[][] = [];
  for (const [y, hw] of rows) {
    const xs = hw === 0 ? [0] : mid ? [-hw, 0, hw] : [-hw, hw];
    at.push(xs.map((x) => { P.push(x, y, bend * y * y + fold * Math.abs(x)); return P.length / 3 - 1; }));
  }
  for (let r = 0; r < at.length - 1; r++) {
    const a = at[r], b = at[r + 1];
    if (a.length === 1) for (let k = 0; k < b.length - 1; k++) I.push(a[0], b[k + 1], b[k]);
    else if (b.length === 1) for (let k = 0; k < a.length - 1; k++) I.push(a[k], a[k + 1], b[0]);
    else for (let k = 0; k < a.length - 1; k++) I.push(a[k], a[k + 1], b[k + 1], a[k], b[k + 1], b[k]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
  return g;
}
/** A branch: rings along the points (parallel-transported, so it never twists), uv = around / along. */
function limb(pts: V3[], rs: number[], ns: number, flare: number | null = null) {
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
  let u = V(), len = 0;
  pts.forEach((q, i) => {
    const d = pts[Math.min(i + 1, pts.length - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize();
    u = i === 0 ? d.clone().cross(Math.abs(d.z) < 0.9 ? Z : X).normalize() : u.clone().addScaledVector(d, -u.dot(d)).normalize();
    const v = d.clone().cross(u);
    if (i) len += q.distanceTo(pts[i - 1]);
    for (let k = 0; k <= ns; k++) {
      const a = (k / ns) * TAU, n = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
      let r = rs[i];
      if (flare !== null) r *= 1 + 0.9 * Math.exp(-(q.z - flare) / 0.16) * (1 + 0.4 * Math.sin(5 * a + 1.3)) + 0.08 * PN.noise(Math.cos(a) * 1.6, Math.sin(a) * 1.6, q.z * 2.5);
      P.push(q.x + n.x * r, q.y + n.y * r, q.z + n.z * r); N.push(n.x, n.y, n.z); U.push((k / ns) * (flare !== null ? 2 : 1), len / 0.5);
    }
  });
  for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < ns; k++) { const a = i * (ns + 1) + k; I.push(a, a + 1, a + ns + 1, a + 1, a + ns + 2, a + ns + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2)); g.setIndex(I);
  return g;
}
/** A procedural texture pair (colour + height for the bump): f(u, v) -> [r, g, b, height] in display values, periodic in u. */
function tex(n: number, f: (cx: number, sx: number, v: number) => number[]) {
  const c = new Uint8Array(n * n * 4), h = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = f(Math.cos((i / n) * TAU), Math.sin((i / n) * TAU), (j / n) * TAU), k = (j * n + i) * 4;
    for (let m = 0; m < 3; m++) { c[k + m] = 255 * Math.min(Math.max(q[m], 0), 1); h[k + m] = 255 * Math.min(Math.max(q[3], 0), 1); }
    c[k + 3] = h[k + 3] = 255;
  }
  const mk = (d: Uint8Array, cs: string) => {
    const t = new THREE.DataTexture(d, n, n); t.colorSpace = cs; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.MirroredRepeatWrapping;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8; t.needsUpdate = true; return t;
  };
  return { map: mk(c, THREE.SRGBColorSpace), bumpMap: mk(h, THREE.NoColorSpace) };
}
const quat = (y: V3, zh: V3) => {                    // rotation taking +Y to y and +Z as near to zh as it goes
  const yy = y.clone().normalize(), xx = yy.clone().cross(zh).normalize(), zz = xx.clone().cross(yy);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xx, yy, zz));
};

// ---------------------------------------------------------------- materials: wind, instancing, light through leaves, fur
const timeU = { value: 0 };
const WIND = `uniform float uTime;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec2 gust(vec2 p, float r) {     // lawn: waves travelling with the wind + each blade's own shiver
  float a = sin(dot(p, vec2(0.9, 0.5)) * 1.1 - uTime * 1.6) + 0.5 * sin(dot(p, vec2(-0.3, 1.0)) * 2.7 - uTime * 2.3);
  return vec2(0.9, 0.45) * (0.10 + 0.07 * a) + vec2(-0.45, 0.9) * 0.03 * sin(uTime * 5.0 + r * 40.0);
}
vec3 sway(vec3 p) {              // trees: one smooth field for wood and leaves, stronger the higher up
  float k = max(p.z - 1.0, 0.0), a = sin(uTime * 1.3 + p.x * 0.5 + p.y * 0.35) + 0.4 * sin(uTime * 2.9 + p.x * 1.6 - p.y * 1.1);
  return vec3(0.9, 0.45, 0.0) * (0.006 * k * a) + vec3(0.0, 0.0, 0.002) * (k * sin(uTime * 2.1 + p.y * 2.0));
}
`;
const trans = (fs: string, t: number[]) => fs.replace("#include <lights_physical_pars_fragment>", THREE.ShaderChunk.lights_physical_pars_fragment.replace(
  "vec3 irradiance = dotNL * directLight.color;", `vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += saturate(-dot(geometryNormal, directLight.direction)) * directLight.color * BRDF_Lambert(material.diffuseContribution * ${v3(t)});`));
/** inst: per-instance iPos/iQuat/iScale/iCol (Scatter). wind: 1 lawn, 2 tree. nb: blend the normal towards the
 * instance's "volume normal" iNrm (a lawn or a crown shades as one soft body). trans: tint of the light coming through
 * from behind. root: brightness at the foot of a blade (the lawn's own shade). */
type Opt = { inst?: boolean; wind?: number; nb?: number; trans?: number[]; root?: number };
function patch<T extends THREE.Material>(m: T, o: Opt): T {
  m.customProgramCacheKey = () => JSON.stringify(o);   // three keys programs by onBeforeCompile's source text: say what differs
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = timeU;
    let vs = s.vertexShader.replace("#include <common>", `#include <common>\n#define WIND ${o.wind ?? 0}\n${o.nb !== undefined ? `#define NB ${fl(o.nb)}\n` : ""}${WIND}`
      + (o.inst ? "attribute vec3 iPos, iScale, iCol, iNrm; attribute vec4 iQuat; attribute float iRnd; varying vec3 vICol; varying float vT;\n" : ""));
    if (o.inst) vs = vs.replace("#include <begin_vertex>", `vec3 transformed = iPos + qrot(iQuat, position * iScale);
#if WIND == 1
transformed.xy += gust(iPos.xy, iRnd) * (position.y * position.y * iScale.y);
#elif WIND == 2
transformed += sway(iPos) + qrot(iQuat, vec3(0.0, 0.0, 1.0)) * (sin(uTime * 7.0 + iRnd * 50.0) * 0.1 * position.y * iScale.y);
#endif
vICol = iCol; vT = position.y;`).replace("#include <beginnormal_vertex>", `vec3 objectNormal = normalize(qrot(iQuat, normal / iScale));
#ifdef NB
if (dot(objectNormal, iNrm) < 0.0) objectNormal = -objectNormal;
objectNormal = normalize(mix(objectNormal, iNrm, NB));
#endif`);
    else if (o.wind === 2) vs = vs.replace("#include <begin_vertex>", "vec3 transformed = position + sway(position);");
    s.vertexShader = vs;
    let fs = s.fragmentShader;
    if (o.inst) fs = fs.replace("#include <common>", "#include <common>\nvarying vec3 vICol; varying float vT;")
      .replace("#include <color_fragment>", `#include <color_fragment>\ndiffuseColor.rgb *= vICol * mix(${fl(o.root ?? 1)}, 1.0, smoothstep(0.0, 0.7, vT));`);
    if (o.nb !== undefined) fs = fs.replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""));
    if (o.trans) fs = trans(fs, o.trans);
    s.fragmentShader = fs;
  };
  return m;
}
class Scatter {                                      // many copies of one small mesh: position, rotation, scale, colour each
  a: number[][] = [[], [], [], [], [], []];
  add(p: V3, q: THREE.Quaternion, s: number[], c: number[], n: V3, r: number) {
    this.a[0].push(p.x, p.y, p.z); this.a[1].push(q.x, q.y, q.z, q.w); this.a[2].push(s[0], s[1], s[2]);
    this.a[3].push(c[0], c[1], c[2]); this.a[4].push(n.x, n.y, n.z); this.a[5].push(r);
  }
  mesh(base: THREE.BufferGeometry, m: THREE.Material, o: Opt) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
    ["iPos", "iQuat", "iScale", "iCol", "iNrm", "iRnd"].forEach((k, i) => g.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(this.a[i]), [3, 4, 3, 3, 3, 1][i])));
    g.instanceCount = this.a[5].length;
    const me = new THREE.Mesh(g, patch(m, { ...o, inst: true }));
    me.customDepthMaterial = patch(new THREE.MeshDepthMaterial({ side: THREE.DoubleSide }), { inst: true, wind: o.wind });   // shadows move with the wind too
    me.frustumCulled = false; me.castShadow = me.receiveShadow = true;
    return me;
  }
}
const std = (c: number[], rough = 0.6, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: col(lin(c)), roughness: rough, ...extra });
const plant = (rough = 0.55, vertexColors = false) => new THREE.MeshStandardMaterial({ roughness: rough, side: THREE.DoubleSide, vertexColors });
const LEAF_T = [0.75, 0.95, 0.25], GRASS_T = [0.7, 0.9, 0.3];

/** Shell fur over a painted mesh: `layers` copies pushed out along the normal, strands cut out by a 3D hash of the skin point. */
function fur(g: THREE.BufferGeometry, len: number, dens: number, layers = 18) {
  const ig = new THREE.InstancedBufferGeometry();
  ig.index = g.index; for (const k in g.attributes) ig.setAttribute(k, g.attributes[k]);
  ig.setAttribute("aLayer", new THREE.InstancedBufferAttribute(Float32Array.from({ length: layers }, (_, i) => (i + 1) / layers), 1));
  ig.instanceCount = layers;
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true });
  m.customProgramCacheKey = () => `fur ${len} ${dens}`;
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\nattribute float aLayer, furLen; varying float vH; varying vec3 vBase;")
      .replace("#include <begin_vertex>", `float fl = aLayer * furLen * ${fl(len)};
vec3 transformed = position + normal * fl + vec3(0.0, -0.5, -0.4) * (fl * aLayer); vH = aLayer; vBase = position;`);   // combed back and down
    s.fragmentShader = trans(s.fragmentShader.replace("#include <common>", `#include <common>\nvarying float vH; varying vec3 vBase;
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 fq = vBase * ${fl(dens)}, ff = fract(fq) - 0.5; float fr = hash3(floor(fq)), fh = 0.5 + 0.5 * fr;   // each strand's own length
if (vH > fh || length(ff) > 0.78 * sqrt(1.0 - vH / fh)) discard;
diffuseColor.rgb *= (0.5 + 0.5 * vH) * (0.75 + 0.5 * fr);`), [1.0, 0.8, 0.55]);
  };
  const skin = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: true, color: col([0.45, 0.45, 0.45]) }));
  const shells = new THREE.Mesh(ig, m);
  skin.castShadow = skin.receiveShadow = shells.receiveShadow = true; shells.frustumCulled = false;
  const o = new THREE.Group(); o.add(skin, shells); return o;
}

// ---------------------------------------------------------------- tree
type Twig = { p: V3; d: V3 };
function growTree(R: () => number, base: V3, s: number, maxDepth: number) {
  const wood: THREE.BufferGeometry[] = [], twigs: Twig[] = [];
  const grow = (p0: V3, d0: V3, len: number, r0: number, depth: number) => {
    const thin = r0 < 0.02 * s, n = Math.max(3, Math.round(len / ((thin ? 0.06 : 0.12) * s)));
    const pts = [p0], rs = [r0], ds = [d0.clone()];
    let p = p0;
    const d = d0.clone();
    for (let i = 1; i <= n; i++) {                                   // wander; the trunk climbs, limbs sag then turn up, twigs hang
      const u = i / n;
      d.add(V(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(depth ? 0.24 : 0.13)).add(V(0, 0, depth === 0 ? 0.03 : depth === 1 ? 0.09 * u - 0.02 : depth >= 3 ? -0.03 : 0.02)).normalize();
      p = p.clone().addScaledVector(d, len / n); pts.push(p); ds.push(d.clone()); rs.push(r0 * (1 - 0.72 * u ** 1.2));
      if (rs[i] < 0.02 * s) twigs.push({ p, d: d.clone() });        // thin wood carries the leaves
    }
    wood.push(limb(pts, rs, depth === 0 ? 24 : thin ? 5 : 9, depth === 0 ? base.z : null));
    if (depth >= maxDepth) return;
    const nk = depth === 0 ? 7 : depth === 1 ? 6 : 4, from = depth === 0 ? 0.4 : 0.22;
    let az = TAU * R();
    for (let k = 0; k < nk; k++) {
      const u = from + (1 - from) * (k + 0.3 + 0.4 * R()) / nk, i = Math.min(n, Math.max(1, Math.round(u * n))), dd = ds[i];
      az += 2.4 + (R() - 0.5) * 0.9;
      const a = dd.clone().cross(Math.abs(dd.z) < 0.9 ? Z : X).normalize(), b = dd.clone().cross(a), tilt = rad(depth === 0 ? 48 + 26 * R() : 35 + 30 * R());
      const dk = dd.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(a, Math.sin(tilt) * Math.cos(az)).addScaledVector(b, Math.sin(tilt) * Math.sin(az));
      const kl = len * (depth === 0 ? 0.56 * (1 - 0.62 * (u - from) / (1 - from)) : 0.5 * (1 - 0.4 * u)) * (0.8 + 0.4 * R());
      grow(pts[i], dk, kl, rs[i] * (depth === 0 ? 0.55 : 0.6), depth + 1);
    }
  };
  grow(base.clone().add(V(0, 0, -0.1)), V(0.12 * (R() - 0.5), 0.12 * (R() - 0.5), 1).normalize(), 4.3 * s, 0.13 * s, 0);
  return { wood: mergeGeometries(wood), twigs };
}
function leafOut(sc: Scatter, R: () => number, twigs: Twig[], centre: V3, per: number, size: number, ca: number[], cb: number[]) {
  for (const { p, d } of twigs) for (let i = 0; i < per; i++) {
    const side = V(R() - 0.5, R() - 0.5, R() - 0.5).cross(d).normalize();
    const at = p.clone().addScaledVector(side, 0.01 + 0.1 * R() * size / 0.08).addScaledVector(d, (R() - 0.5) * 0.08);
    const dir = side.clone().addScaledVector(d, 0.4).add(V(0, 0, -0.45)).normalize();              // out from the twig, hanging a little
    const out = at.clone().sub(centre).normalize().add(V(0, 0, 0.5)).normalize(), s = size * (0.7 + 0.6 * R());
    const c = mix(ca, cb, R() ** 1.5).map((x) => x * (0.75 + 0.5 * R()));
    sc.add(at, quat(dir, out.clone().add(V(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(1.2))), [s, s, s], c, out, R());
  }
}
function bush(sc: Scatter, R: () => number, c: V3, rx: number, ry: number, rz: number, n: number, size: number, ca: number[], cb: number[]) {
  for (let i = 0; i < n; i++) {
    const z = -0.1 + 1.1 * R(), a = TAU * R(), q = Math.sqrt(Math.max(1 - z * z, 0)), d = V(q * Math.cos(a), q * Math.sin(a), z);
    const k = (0.7 + 0.3 * Math.sqrt(R())) * (1 + 0.2 * PN.noise(d.x * 2.5 + c.x, d.y * 2.5 + c.y, d.z * 2.5));
    const p = V(c.x + d.x * rx * k, c.y + d.y * ry * k, c.z + d.z * rz * k), out = V(d.x / rx, d.y / ry, d.z / rz).normalize();
    const dir = out.clone().add(V(R() - 0.5, R() - 0.5, R() - 0.4).multiplyScalar(1.8)).normalize(), s = size * (0.7 + 0.6 * R());
    sc.add(p, quat(dir, out.clone().add(V(R() - 0.5, R() - 0.5, R() - 0.5))), [s, s, s], mix(ca, cb, R() ** 1.5).map((x) => x * (0.7 + 0.6 * R())), out.clone().lerp(Z, 0.3).normalize(), R());
  }
}

// ---------------------------------------------------------------- animals
function makeRabbit(eye: THREE.Material) {             // local: +Y forward, Z up, origin on the ground under the belly
  const brown = lin([0.64, 0.56, 0.46]), cream = lin([0.90, 0.86, 0.78]), rust = lin([0.68, 0.50, 0.32]), dark = lin([0.3, 0.25, 0.2]);
  const body = mergeGeometries([
    loft([[-0.16, 0.07, 0.055, 0.055], [-0.1, 0.098, 0.082, 0.088], [-0.01, 0.1, 0.078, 0.082], [0.07, 0.086, 0.06, 0.063], [0.115, 0.094, 0.04, 0.043]]),
    ell(V(0.066, -0.08, 0.066), 0.034, 0.078, 0.064), ell(V(-0.066, -0.08, 0.066), 0.034, 0.078, 0.064),           // haunches
    ell(V(0.05, -0.035, 0.014), 0.017, 0.06, 0.013), ell(V(-0.05, -0.035, 0.014), 0.017, 0.06, 0.013),             // hind feet
    stick(V(0.03, 0.085, 0.06), V(0.032, 0.115, 0.012), 0.015, 0.017, 10), stick(V(-0.03, 0.085, 0.06), V(-0.032, 0.115, 0.012), 0.015, 0.017, 10),
    ell(V(0.032, 0.125, 0.01), 0.014, 0.02, 0.01), ell(V(-0.032, 0.125, 0.01), 0.014, 0.02, 0.01),                 // front paws
    ell(V(0, -0.2, 0.062), 0.03, 0.03, 0.032)]);                                                                    // tail
  paint(body, (p) => {
    const belly = sm((0.05 - p.z) / 0.035), tail = sm((-0.17 - p.y) / 0.02) * sm((0.075 - p.z) / 0.03), nape = sm((p.y - 0.06) / 0.05) * sm((p.z - 0.09) / 0.03);
    const c = mix(mix(mix(brown, rust, 0.45 * nape), cream, 0.85 * belly), [0.9, 0.9, 0.88], tail);
    return [...c, p.z < 0.03 ? 0.35 : 0.75 + 0.25 * belly + 0.3 * tail];
  });
  const headG = mergeGeometries([loft([[-0.025, 0.012, 0.03, 0.032], [0.015, 0.024, 0.039, 0.041], [0.052, 0.014, 0.034, 0.035], [0.083, -0.003, 0.023, 0.023], [0.099, -0.01, 0.014, 0.013]]),
    ell(V(0.02, 0.05, -0.004), 0.02, 0.03, 0.02), ell(V(-0.02, 0.05, -0.004), 0.02, 0.03, 0.02)]);
  paint(headG, (p) => {
    const nose = sm((p.y - 0.075) / 0.02), chin = sm((0.0 - p.z) / 0.025), eyeD = Math.hypot(Math.abs(p.x) - 0.032, p.y - 0.036, p.z - 0.026);
    return [...mix(mix(brown, cream, Math.max(0.7 * chin, 0.5 * nose)), cream, 0.5 * sm((0.02 - eyeD) / 0.01)), Math.min(0.55 - 0.35 * nose, 0.12 + eyeD * 22)];
  });
  const earG = paint(loft([[0, 0, 0.008, 0.006], [0, 0.03, 0.0125, 0.006], [0, 0.065, 0.0135, 0.005], [0, 0.095, 0.007, 0.004]], 16), (p) => [...mix(mix(brown, lin([0.62, 0.42, 0.38]), sm(-p.y / 0.003)), dark, sm((p.z - 0.06) / 0.035)), 0.2]);
  const g = new THREE.Group(), head = new THREE.Group(), ears = [1, -1].map((s) => { const e = fur(earG, 0.012, 900, 8); e.position.set(0.013 * s, -0.008, 0.047); head.add(e); return e; });
  head.position.set(0, 0.105, 0.105); head.add(fur(headG, 0.02, 800));
  for (const s of [1, -1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.0095, 16, 12), eye); e.position.set(0.0315 * s, 0.036, 0.026); head.add(e); }
  const torso = fur(body, 0.024, 700);
  g.add(torso, head);
  return { g, head, ears, torso };
}
function makeBird(bodyC: (p: V3) => number[], headC: (p: V3) => number[], beakC: number[], eye: THREE.Material) {   // +Y forward, feet at the origin
  const feather = new THREE.MeshPhysicalMaterial({ roughness: 0.55, vertexColors: true, sheen: 0.6, sheenRoughness: 0.5, sheenColor: col([0.25, 0.27, 0.32]) });
  const wing = (s: number) => {
    const w = loft([[0.04, 0.098, 0.008, 0.02], [0.0, 0.088, 0.01, 0.03], [-0.05, 0.074, 0.008, 0.022], [-0.105, 0.064, 0.004, 0.008]], 14);
    const P = w.attributes.position; for (let i = 0; i < P.count; i++) P.setX(i, P.getX(i) + s * (0.035 + 0.12 * P.getY(i)));
    return w;
  };
  const bodyG = paint(mergeGeometries([
    loft([[-0.062, 0.062, 0.012, 0.012], [-0.04, 0.066, 0.03, 0.028], [0.0, 0.075, 0.04, 0.04], [0.035, 0.09, 0.036, 0.037], [0.058, 0.108, 0.024, 0.026]]),
    loft([[-0.05, 0.066, 0.016, 0.006], [-0.1, 0.056, 0.02, 0.004], [-0.155, 0.046, 0.022, 0.003]], 14, 3), wing(1), wing(-1)]), bodyC);
  const headG = paint(loft([[-0.012, 0.0, 0.019, 0.019], [0.008, 0.01, 0.024, 0.024], [0.026, 0.01, 0.018, 0.017]]), headC);
  const g = new THREE.Group(), tilt = new THREE.Group(), head = new THREE.Group();
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material) => { const o = new THREE.Mesh(geo, m); o.castShadow = o.receiveShadow = true; parent.add(o); return o; };
  tilt.position.set(0, 0, 0.05); add(tilt, bodyG, feather).position.set(0, 0, -0.05);
  head.position.set(0, 0.055, 0.062); tilt.add(head);
  add(head, headG, feather);
  add(head, stick(V(0, 0.028, 0.009), V(0, 0.06, 0.004), 0.0065, 0.0008, 8), std(beakC, 0.4));
  for (const s of [1, -1]) {
    add(head, new THREE.SphereGeometry(0.0036, 12, 8).translate(0.0172 * s, 0.017, 0.014), eye);
    add(head, new THREE.SphereGeometry(0.0052, 12, 8).scale(0.5, 1, 1).translate(0.0158 * s, 0.017, 0.014), std(beakC, 0.5));   // eye ring
  }
  const legs: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const a = V(0.014 * s, -0.004, 0.004);
    legs.push(stick(V(0.013 * s, 0.0, 0.06), V(0.014 * s, 0.008, 0.03), 0.003), stick(V(0.014 * s, 0.008, 0.03), a, 0.0022));
    for (const t of [[-0.012, 0.024], [0, 0.028], [0.012, 0.024], [0, -0.016]]) legs.push(stick(a, V(a.x + t[0], a.y + t[1], 0.0015), 0.0016));
  }
  add(g, mergeGeometries(legs), std([0.16, 0.11, 0.07], 0.6));
  g.add(tilt);
  return { g, tilt, head };
}
function makeButterfly() {
  const shape = (pts: number[][]) => { const s = new THREE.Shape(); pts.forEach((p, i) => (i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1]))); return bare(new THREE.ShapeGeometry(s)); };
  const wingG = paint(mergeGeometries([shape([[0, 0.002], [0.012, 0.022], [0.026, 0.026], [0.03, 0.016], [0.024, 0.004], [0.012, -0.002]]),
    shape([[0, 0], [0.014, -0.002], [0.022, -0.012], [0.016, -0.024], [0.006, -0.02], [0, -0.008]])]),
  (p) => mix(lin([0.93, 0.93, 0.86]), lin([0.2, 0.2, 0.2]), Math.max(sm((0.011 - Math.hypot(p.x - 0.029, p.y - 0.024)) / 0.006), 0.8 * sm((0.004 - Math.hypot(p.x - 0.02, p.y - 0.012)) / 0.002))));
  const m = patch(new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide, vertexColors: true }), { trans: [0.9, 0.9, 0.8] });
  const g = new THREE.Group(), wings = [1, -1].map((s) => { const w = new THREE.Mesh(wingG, m); w.scale.x = s; w.castShadow = true; g.add(w); return w; });
  g.add(new THREE.Mesh(stick(V(0, -0.01, 0), V(0, 0.012, 0), 0.0013), std([0.1, 0.1, 0.1])));
  return { g, wings };
}

// ---------------------------------------------------------------- the whole scene
async function build(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true; renderer.shadowMap.autoUpdate = false;
  renderer.debug.onShaderError = (gl, _p, vs, fs) => { throw new Error(`shader: ${gl.getShaderInfoLog(vs)} ${gl.getShaderInfoLog(fs)}`); };   // else a broken shader is just a missing object

  const lutBuf = await fetch(staticFile("js3d/agx_mhc_65.bin")).then((r) => r.arrayBuffer());
  const N = 65, lf = new Float32Array(lutBuf), lh = new Uint16Array(N ** 3 * 4);
  for (let i = 0; i < N ** 3; i++) for (let k = 0; k < 4; k++) lh[i * 4 + k] = THREE.DataUtils.toHalfFloat(k < 3 ? lf[i * 3 + k] : 1);
  const lut = new THREE.Data3DTexture(lh, N, N, N);
  lut.type = THREE.HalfFloatType; lut.format = THREE.RGBAFormat; lut.unpackAlignment = 1;
  lut.minFilter = lut.magFilter = THREE.LinearFilter; lut.wrapS = lut.wrapT = lut.wrapR = THREE.ClampToEdgeWrapping; lut.needsUpdate = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(col([0.9, 0.62, 0.38]), 0.018);     // evening haze: far things go warm and pale
  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);   // Blender Z up -> three Y up
  const put = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = root) => { const o = new THREE.Mesh(g, m); o.castShadow = o.receiveShadow = true; parent.add(o); return o; };

  // sky: a dome to look at, an environment for the few glossy things, and the function skyRad for the light
  const skyG = new THREE.Group(); skyG.rotation.x = -Math.PI / 2;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: "varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }", fragmentShader: SKY_FS }));
  dome.frustumCulled = false; skyG.add(dome);
  const envScene = new THREE.Scene(); envScene.add(skyG);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(envScene, 0, 1, 2000).texture;
  pmrem.dispose(); scene.add(skyG);
  const eye = new THREE.MeshPhysicalMaterial({ color: col([0.012, 0.008, 0.006]), roughness: 0.06, envMap: env, clearcoat: 1 });

  // lights. Units: sun 6 on a surface facing it (white comes out at 1.9), the sky from skyRad, the lawn's own bounce from below
  const sun = new THREE.DirectionalLight(col([1.0, 0.72, 0.46]), 6.0), skyL = new THREE.DirectionalLight(0xffffff, TAU * 0.9);
  for (const [l, n] of [[sun, 8192], [skyL, 4096]] as const) {
    l.castShadow = true; l.shadow.mapSize.set(n, n); l.shadow.bias = -0.0004; l.shadow.normalBias = 0.012; scene.add(l, l.target);
  }
  scene.add(new THREE.HemisphereLight(0x000000, col([0.26, 0.32, 0.11]), 1.0));
  const CEN = b2t(V(0, 3, 3)), CORNERS = Array.from({ length: 8 }, (_, i) => b2t(V(i & 1 ? 6.5 : -6.5, i & 2 ? 12.5 : -6, i & 4 ? 6.5 : -0.3)));
  function aim(l: THREE.DirectionalLight, d: V3) {                 // point a light and fit its shadow map around the garden
    l.position.copy(CEN).addScaledVector(b2t(d), 40); l.target.position.copy(CEN);
    const inv = new THREE.Matrix4().lookAt(l.position, CEN, V(0, 1, 0)).setPosition(l.position).invert();
    const b = new THREE.Box3().setFromPoints(CORNERS.map((c) => c.clone().applyMatrix4(inv))), c = l.shadow.camera;
    c.left = b.min.x; c.right = b.max.x; c.bottom = b.min.y; c.top = b.max.y; c.near = -b.max.z - 1; c.far = -b.min.z + 1; c.updateProjectionMatrix();
  }

  // textures
  const bark = tex(512, (cx, sx, v) => {
    let h = 0; for (const o of [1, 2, 4]) h += (1 - Math.abs(PN.noise(cx * 2.6 * o, sx * 2.6 * o, v * 0.55 * o))) / o;
    h = Math.min(Math.max((h / 1.75 - 0.45) * 2.2, 0), 1) ** 1.5;
    const lichen = sm((fbm(cx * 1.2 + 5, sx * 1.2, v * 0.4) - 0.12) * 5), c = mix(mix([0.13, 0.10, 0.08], [0.47, 0.40, 0.33], h), [0.50, 0.55, 0.36], 0.6 * lichen * h);
    return [...c, h];
  });
  const stone = tex(256, (cx, sx, v) => { const n = fbm(cx * 2, sx * 2, v * 2, 5), s = PN.noise(cx * 30, sx * 30, v * 30); return [0.56 + 0.3 * n + 0.06 * s, 0.54 + 0.3 * n + 0.06 * s, 0.50 + 0.27 * n + 0.05 * s, 0.5 + 0.8 * n + 0.15 * s]; });
  const wood = tex(256, (cx, sx, v) => { const n = fbm(cx * 3.5, sx * 3.5, v * 0.25, 4), g = 0.5 + 0.5 * Math.sin((cx * 9 + n * 6) * 3); return [0.40 + 0.22 * n + 0.07 * g, 0.34 + 0.2 * n + 0.06 * g, 0.28 + 0.17 * n + 0.05 * g, g * 0.6 + n]; });
  const soil = tex(256, (cx, sx, v) => { const n = fbm(cx * 4, sx * 4, v * 4, 5); return [0.20 + 0.16 * n, 0.17 + 0.13 * n, 0.09 + 0.08 * n, 0.5 + n]; });

  // ground
  const groundG = new THREE.PlaneGeometry(60, 60, 200, 200), gp = groundG.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setZ(i, gz(gp.getX(i), gp.getY(i)));
  groundG.computeVertexNormals();
  soil.map.repeat.set(40, 40); soil.bumpMap.repeat.set(40, 40);
  put(groundG, new THREE.MeshStandardMaterial({ ...soil, bumpScale: 2, roughness: 0.95 })).castShadow = false;

  // stepping stones, bird bath, fence
  const R = rng(7);
  const stoneM = new THREE.MeshStandardMaterial({ ...stone, bumpScale: 1.5, roughness: 0.85 });
  for (const [x, y, r] of STONES) {
    const ph = R() * 9, rr = (a: number, k: number) => r * k * (1 + 0.16 * Math.sin(2 * a + ph) + 0.09 * Math.sin(3 * a + 2 * ph) + 0.05 * Math.sin(5 * a + ph));
    const rg = (z: number, k: number) => Array.from({ length: 20 }, (_, i) => { const a = (i / 20) * TAU; return V(x + rr(a, k) * Math.cos(a), y + rr(a, k) * Math.sin(a), gz(x, y) + z); });
    const g = solid([rg(-0.03, 0.9), rg(0.0, 1), rg(0.028, 0.99), rg(0.04, 0.9)], [G(x, y, -0.03), G(x, y, 0.042)]), P = g.attributes.position;
    g.setAttribute("uv", new THREE.Float32BufferAttribute(Array.from({ length: P.count }, (_, i) => [P.getX(i) * 1.3, P.getY(i) * 1.3]).flat(), 2));
    put(g, stoneM);
  }
  const bathG = new THREE.LatheGeometry([[0.001, 0], [0.2, 0], [0.19, 0.035], [0.08, 0.09], [0.058, 0.2], [0.055, 0.5], [0.085, 0.58], [0.29, 0.655], [0.32, 0.69], [0.318, 0.705], [0.3, 0.705], [0.27, 0.675], [0.001, 0.645]]
    .map((p) => new THREE.Vector2(p[0], p[1])), 48).rotateX(Math.PI / 2);
  const bath = put(bathG, stoneM); bath.position.copy(G(BATH.x, BATH.y, -0.01));
  const water = put(new THREE.CircleGeometry(0.275, 48), new THREE.MeshPhysicalMaterial({ color: col([0.01, 0.014, 0.012]), roughness: 0.03, envMap: env }));
  water.position.copy(G(BATH.x, BATH.y, 0.672)); water.castShadow = false;
  const boards: THREE.BufferGeometry[] = [];
  for (let x = -7; x < 7; x += 0.128) {
    const h = 1.5 + 0.03 * R(), g = new THREE.BoxGeometry(0.12, 0.022, h).rotateY((R() - 0.5) * 0.02).translate(x, FENCE_Y + (R() - 0.5) * 0.01, gz(x, FENCE_Y) + h / 2 - 0.03);
    const uv = g.attributes.uv, o = R(), k = 0.7 + 0.5 * R();
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.12 + o, uv.getY(i) * 0.9 + o * 7);
    boards.push(paint(g, () => [k, k * (0.96 + 0.06 * R()), k * 0.93]));
  }
  put(mergeGeometries(boards), new THREE.MeshStandardMaterial({ ...wood, bumpScale: 1.2, roughness: 0.9, vertexColors: true }));

  // tree, background trees, bushes: wood + one Scatter of leaves
  const leaves = new Scatter(), apples = new Scatter(), fallen = new Scatter(), petals = new Scatter();
  const leafA = lin([0.20, 0.36, 0.10]), leafB = lin([0.42, 0.52, 0.16]);
  const barkM = patch(new THREE.MeshStandardMaterial({ ...bark, bumpScale: 3, roughness: 0.92 }), { wind: 2 });
  const main = growTree(rng(11), G(TREE.x, TREE.y), 1, 4);
  put(main.wood, barkM);
  leafOut(leaves, rng(12), main.twigs, V(TREE.x, TREE.y, 3.0), 14, 0.085, leafA, leafB);
  const RA = rng(13);
  for (let i = 0; i < 46; i++) {                                    // apples hanging under the twigs
    const t = main.twigs[Math.floor(RA() * main.twigs.length)], s = 0.03 + 0.008 * RA();
    apples.add(t.p.clone().add(V(0, 0, -s - 0.01)), quat(V(RA() - 0.5, RA() - 0.5, 3).normalize(), X), [s, s * 0.9, s], mix(lin([0.62, 0.08, 0.05]), lin([0.62, 0.62, 0.16]), RA() ** 2), Z, RA());
  }
  for (const [x, y, s, seed] of [[-5.6, 10.5, 1.9, 21], [1.6, 13.5, 2.2, 22], [5.4, 15.5, 1.8, 23]]) {
    const t = growTree(rng(seed), G(x, y), s, 3);
    put(t.wood, barkM);
    leafOut(leaves, rng(seed + 50), t.twigs, V(x, y, 3 * s), 14, 0.24, lin([0.16, 0.30, 0.09]), lin([0.36, 0.46, 0.14]));
  }
  const coreM = std([0.05, 0.07, 0.03], 0.9);
  BUSHES.forEach(([x, y, rx, ry, rz], i) => {
    const c = G(x, y);
    put(ell(c, rx * 0.7, ry * 0.7, rz * 0.7), coreM);              // a dark heart, so no light comes straight through
    bush(leaves, rng(30 + i), c, rx, ry, rz, Math.round(9000 * rx * rz / 0.8), i === 1 ? 0.075 : 0.045, i === 1 ? lin([0.22, 0.38, 0.12]) : lin([0.12, 0.25, 0.08]), i === 1 ? leafB : lin([0.26, 0.40, 0.12]));
  });
  HEDGE.forEach(([x, y, h], i) => {                               // a row of big shrubs behind the fence
    put(ell(G(x, y), 1.05, 0.8, h * 0.72), coreM);
    bush(leaves, rng(70 + i), G(x, y), 1.5, 1.1, h, 7000, 0.11, lin([0.13, 0.26, 0.08]), lin([0.30, 0.42, 0.13]));
  });
  const RH = rng(40), hc = G(BUSHES[1][0], BUSHES[1][1]);          // hydrangea: balls of small petals on the second bush
  for (let b = 0; b < 11; b++) {
    const a = TAU * RH(), zz = 0.25 + 0.7 * RH(), q = Math.sqrt(1 - zz * zz), bc = V(hc.x + q * Math.cos(a) * 0.74, hc.y + q * Math.sin(a) * 0.7, hc.z + zz * 0.7);
    const tint = mix(lin([0.86, 0.50, 0.70]), lin([0.55, 0.56, 0.92]), RH()), br = 0.07 + 0.035 * RH();
    for (let i = 0; i < 420; i++) {
      const z = -0.3 + 1.3 * RH(), an = TAU * RH(), qq = Math.sqrt(Math.max(1 - z * z, 0)), d = V(qq * Math.cos(an), qq * Math.sin(an), z);
      petals.add(bc.clone().addScaledVector(d, br * (0.85 + 0.15 * RH())), quat(V(RH() - 0.5, RH() - 0.5, RH() - 0.5).cross(d), d), [0.013, 0.013, 0.013], tint.map((x) => x * (0.75 + 0.5 * RH())), d, RH());
    }
  }
  for (let i = 0; i < 260; i++) {                                   // leaves and a few apples that have dropped
    const a = TAU * R(), r = 0.3 + 2.6 * Math.sqrt(R()), x = TREE.x + r * Math.cos(a), y = TREE.y + r * Math.sin(a) - 0.6, s = 0.07 + 0.03 * R();
    fallen.add(G(x, y, 0.02 + 0.05 * R()), quat(V(R() - 0.5, R() - 0.5, 0.1 * (R() - 0.5)), V(0.4 * (R() - 0.5), 0.4 * (R() - 0.5), 1)), [s, s, s], mix(lin([0.62, 0.50, 0.14]), lin([0.42, 0.24, 0.10]), R()), Z, R());
    if (i < 9) { const sa = 0.032; apples.add(G(x * 0.8, y * 0.8 - 0.5, sa * 0.8), quat(V(R() - 0.5, R() - 0.5, R()), X), [sa, sa * 0.9, sa], mix(lin([0.62, 0.08, 0.05]), lin([0.62, 0.62, 0.16]), R()), Z, R()); }
  }
  const leafG = ribbon([[0, 0], [0.08, 0.05], [0.32, 0.23], [0.58, 0.27], [0.83, 0.17], [1, 0]], 0.25, -0.18);
  root.add(leaves.mesh(leafG, plant(0.5), { wind: 2, nb: 0.5, trans: LEAF_T }));
  root.add(fallen.mesh(leafG, plant(0.7), { nb: 0.6 }));
  root.add(petals.mesh(ribbon([[0, 0.15], [0.5, 0.5], [1, 0.3]], 0.1, -0.2), plant(0.6), { wind: 2, nb: 0.6, trans: [0.9, 0.8, 0.9] }));
  root.add(apples.mesh(bare(new THREE.SphereGeometry(1, 20, 14)), new THREE.MeshPhysicalMaterial({ roughness: 0.38, clearcoat: 0.4, clearcoatRoughness: 0.25 }), { wind: 2 }));

  // lawn: tufts of blades inside what the camera sees, thinning out with distance; daisies, dandelions, lavender
  const lawn = new Scatter(), daisies = new Scatter(), lav = new Scatter();
  const lush = lin([0.24, 0.42, 0.11]), pale = lin([0.52, 0.60, 0.22]), straw = lin([0.74, 0.66, 0.40]);
  const near = (x: number, y: number, px: number, py: number, r: number) => Math.hypot(x - px, y - py) < r;
  const blocked = (x: number, y: number) => y > FENCE_Y - 0.03 || near(x, y, TREE.x, TREE.y, 0.2) || near(x, y, BATH.x, BATH.y, 0.2)
    || STONES.some((s) => near(x, y, s[0], s[1], s[2] * 0.93)) || BUSHES.some((b) => near(x, y, b[0], b[1], b[2] * 0.6));
  const rough = (x: number, y: number) => Math.max(sm((0.75 - Math.hypot(x - TREE.x, y - TREE.y)) / 0.5), sm((y - FENCE_Y + 0.7) / 0.5),   // where the mower does not reach
    sm((0.5 - Math.hypot(x - BATH.x, y - BATH.y)) / 0.25), ...STONES.map((s) => 0.6 * sm((s[2] + 0.12 - Math.hypot(x - s[0], y - s[1])) / 0.1)), ...BUSHES.map((b) => sm((b[2] + 0.3 - Math.hypot(x - b[0], y - b[1])) / 0.3)));
  const upQ = (az: number, lean: number) => quat(V(Math.sin(lean) * Math.cos(az), Math.sin(lean) * Math.sin(az), Math.cos(lean)), V(-Math.cos(lean) * Math.cos(az), -Math.cos(lean) * Math.sin(az), Math.sin(lean) + 1e-4));
  for (let i = 0; i < 175000; i++) {
    const x = -5.2 + 10.4 * R(), y = -4.1 + 10.2 * R(), d = y + 5.3;
    if (Math.abs(x + 0.55 - 0.1 * d) > 0.27 * d + 0.6) continue;
    const keep = d < 3.5 ? 1 : Math.max(0.28, (3.5 / d) ** 1.3);
    if (R() > keep || blocked(x, y)) continue;
    const patchy = 0.5 + fbm(x * 0.5, y * 0.5), dry = 0.5 + fbm(x * 1.3 + 9, y * 1.3), ro = rough(x, y), h0 = (0.06 + 0.05 * patchy + 0.03 * R()) * (1 + 1.1 * ro);
    const base = mix(lush, pale, Math.min(Math.max(dry * 1.2 - 0.1, 0), 1)), nb = 4 + Math.floor(4 * R());
    for (let b = 0; b < nb; b++) {
      const az = TAU * R(), off = 0.018 * Math.sqrt(R()), lean = 0.08 + 0.5 * R() * (0.4 + off / 0.018), h = h0 * (0.55 + 0.6 * R());
      const c = (R() < 0.07 ? straw : base).map((v) => v * (0.75 + 0.5 * R()));
      lawn.add(G(x + off * Math.cos(az), y + off * Math.sin(az)), upQ(az, lean), [(0.0045 + 0.003 * R()) / Math.sqrt(keep), h, -h * (0.1 + 0.5 * R())], c, V(0.3 * (R() - 0.5), 0.3 * (R() - 0.5), 1).normalize(), R());
    }
    if (R() < 0.011 && fbm(x * 0.8 + 3, y * 0.8) > -0.05 && ro < 0.3) {                             // daisies in drifts, the odd dandelion
      const dandelion = R() < 0.18, hgt = (dandelion ? 0.1 : 0.065) + 0.03 * R(), s = dandelion ? 0.017 : 0.011 + 0.003 * R();
      daisies.add(G(x, y), upQ(TAU * R(), 0.25 * R()), [s, hgt, s], dandelion ? [1.0, 0.72, 0.06] : [1, 1, 1], Z, R());
    }
  }
  for (const [cx, cy, n] of [[1.3, 0.5, 520], [-1.0, 0.45, 420]]) for (let i = 0; i < n; i++) {    // two lavender clumps
    const az = TAU * R(), r = 0.2 * Math.sqrt(R()), h = 0.28 + 0.2 * R();
    for (let b = 0; b < 3; b++) {                                    // the grey-green mound under the flower stems
      const a2 = TAU * R(), r2 = 0.24 * Math.sqrt(R()), hb = 0.1 + 0.14 * R();
      lawn.add(G(cx + r2 * Math.cos(a2), cy + r2 * Math.sin(a2)), upQ(a2, 0.15 + 2.5 * r2 * R()), [0.004, hb, -hb * 0.2 * R()], lin([0.40, 0.50, 0.40]).map((v) => v * (0.7 + 0.6 * R())), Z, R());
    }
    lav.add(G(cx + r * Math.cos(az), cy + r * Math.sin(az)), upQ(az, 0.1 + 2.2 * r * (0.6 + 0.6 * R())), [0.01, h, -h * 0.08 * R()], [0.8 + 0.4 * R(), 0.8 + 0.4 * R(), 0.8 + 0.4 * R()], V(Math.cos(az) * 0.5, Math.sin(az) * 0.5, 1).normalize(), R());
  }
  const flat = (g: THREE.BufferGeometry, c: number[]) => paint(bare(g), () => lin(c));
  const petal = ribbon([[0.2, 0.1], [0.65, 0.17], [1, 0.06]]).rotateX(-Math.PI / 2);
  const daisyG = mergeGeometries([flat(new THREE.CylinderGeometry(0.05, 0.06, 1, 4, 1).translate(0, 0.5, 0), [0.30, 0.45, 0.16]),
    ...Array.from({ length: 15 }, (_, i) => flat(petal.clone().rotateY((i / 15) * TAU).translate(0, 1, 0), [0.95, 0.95, 0.92])),
    flat(new THREE.SphereGeometry(0.3, 10, 6).scale(1, 0.25, 1).translate(0, 1.01, 0), [0.95, 0.72, 0.08])]);
  const spike = ribbon([[0.86, 0], [0.89, 0.16], [0.96, 0.15], [1, 0]]);
  const lavG = mergeGeometries([flat(ribbon([[0, 0.07], [0.82, 0.05]]), [0.45, 0.52, 0.40]), flat(spike, [0.52, 0.44, 0.72]), flat(spike.clone().rotateY(Math.PI / 2), [0.46, 0.38, 0.66])]);
  root.add(lawn.mesh(ribbon([[0, 0.5], [0.45, 0.42], [0.8, 0.25], [1, 0]], 0, 1, false), plant(0.5), { wind: 1, nb: 0.7, trans: GRASS_T, root: 0.3 }));
  root.add(daisies.mesh(daisyG, plant(0.6, true), { wind: 1, nb: 0.3, trans: [0.8, 0.8, 0.7], root: 0.6 }));
  root.add(lav.mesh(lavG, plant(0.6, true), { wind: 1, nb: 0.4, trans: [0.7, 0.6, 0.8], root: 0.5 }));

  // animals
  const rabbit = makeRabbit(eye);
  rabbit.g.position.copy(G(RABBIT.x, RABBIT.y, 0.005)); rabbit.g.rotation.z = rad(128); root.add(rabbit.g);
  const black = () => lin([0.035, 0.035, 0.04]);
  const blackbird = makeBird(black, black, [0.95, 0.60, 0.08], eye);
  root.add(blackbird.g);
  const robin = makeBird((p) => (p.y > 0.012 && p.z < 0.082 + 0.45 * p.y ? lin([0.85, 0.36, 0.10]) : p.z < 0.07 && p.y > -0.045 ? lin([0.80, 0.78, 0.72]) : lin([0.36, 0.30, 0.20])),
    (p) => (p.y > 0.0 && p.z < 0.016 ? lin([0.85, 0.36, 0.10]) : lin([0.36, 0.30, 0.20])), [0.12, 0.10, 0.08], eye);
  robin.g.scale.setScalar(0.58); robin.g.position.copy(G(BATH.x, BATH.y, 0.695)).add(V(-0.285, -0.1, 0)); root.add(robin.g);
  const flies = [0, 1, 2].map(() => { const b = makeButterfly(); root.add(b.g); return b; });
  const midges = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0016, 6, 4), patch(new THREE.MeshStandardMaterial({ color: col([0.9, 0.85, 0.7]), roughness: 0.8 }), { trans: [1.6, 1.6, 1.6] }), 60);
  midges.frustumCulled = false; root.add(midges);
  const MR = rng(60), MID = Array.from({ length: 60 }, () => Array.from({ length: 9 }, () => MR()));
  const leafM = patch(new THREE.MeshStandardMaterial({ color: col(lin([0.70, 0.56, 0.14])), roughness: 0.6, side: THREE.DoubleSide }), { trans: LEAF_T });
  const drops = [[30, -0.25, 0.85, 3.1, 0.4], [112, 0.35, 1.2, 2.8, 2.1]].map((d) => { const o = put(leafG, leafM); o.scale.setScalar(0.085); return [o, ...d] as [THREE.Mesh, ...number[]]; });

  // ---------------------------------------------------------------- animation (a pure function of the frame)
  const HEAD: Key[] = [[0, [38, 0, 36, 36]], [100, [38, 0, 36, 36]], [111, [-4, 8, 8, 10]], [150, [-8, 30, 4, 12]], [186, [-5, 22, 8, 6]], [214, [36, 0, 32, 34]], [239, [38, 0, 36, 36]]];
  const HOPS = [62, 71, 80, 89, 98, 107];                          // the blackbird's hops, 5 frames each, onto the third stone
  const BB: Key[] = [[0, [0, 0, 0]], [118, [0, 0, 0]], [121, [0, 28, 30]], [136, [0, 28, 30]], [139, [58, 0, 0]], [143, [58, 0, 0]], [147, [0, 0, -20]],
    [158, [0, 0, -20]], [161, [60, 0, 5]], [165, [60, 0, 5]], [169, [-6, 0, 40]], [196, [-6, 0, 40]], [199, [-4, -25, -30]], [239, [-4, -25, -30]]];   // body pitch, head roll, head yaw
  const RB: Key[] = [[0, [0, 0]], [18, [0, 0]], [22, [62, 0]], [30, [62, 0]], [34, [-22, 0]], [52, [-22, 0]], [55, [0, 50]], [74, [0, 50]], [77, [0, -40]], [92, [0, -40]],
    [96, [62, 0]], [104, [62, 0]], [108, [-22, 0]], [128, [-22, 0]], [131, [0, 60]], [160, [0, 60]], [163, [0, -10]], [200, [0, -10]], [203, [0, 70]], [239, [0, 70]]];
  const CAM: [number, number[], number[], number][] = [[0, [-0.55, -5.3, 0.48], [0.05, 0.6, 1.3], 27], [239, [-0.32, -4.55, 0.54], [0.08, 0.6, 1.26], 28]];
  const m4 = new THREE.Matrix4();
  function update(fr: number) {
    const t = fr / 30;
    timeU.value = t;
    const [pitch, yaw, e1, e2] = spline(fr, HEAD), chew = sm((pitch - 10) / 20);
    rabbit.head.rotation.set(-rad(pitch + 2.5 * chew * Math.sin(TAU * 4.5 * t)), 0, rad(yaw), "ZXY");
    rabbit.head.position.z = 0.105 + 0.0015 * chew * Math.sin(TAU * 4.5 * t);
    rabbit.ears.forEach((e, i) => e.rotation.set(rad(i ? e2 : e1) + 0.03 * Math.sin(t * 9 + i), 0.2 * (i ? -1 : 1), i ? -rad(yaw * 0.5) : 0));
    const br = 1 + 0.012 * Math.sin(TAU * 1.5 * t); rabbit.torso.scale.set(br, 1, br);
    let bx = -1.36, bz = 0, lift = 0;
    for (const h of HOPS) { const u = Math.min(Math.max((fr - h) / 5, 0), 1); bx += 0.153 * u; if (u > 0 && u < 1) { bz = 0.05 * 4 * u * (1 - u); lift = Math.sin(Math.PI * u); } }
    const by = -1.95 - 0.1 * (bx + 1.36), onStone = sm((bx + 0.68) / 0.1) * 0.04, [bp, hr, hy] = spline(fr, BB);
    blackbird.g.position.copy(G(bx, by, bz + onStone)); blackbird.g.rotation.z = rad(-90 + 12 * sm((fr - 196) / 4));
    blackbird.tilt.rotation.x = -rad(bp + 14 * lift); blackbird.head.rotation.set(rad(-0.5 * bp), rad(hr), rad(hy), "ZXY");
    const [rp, ry] = spline(fr, RB);
    robin.g.rotation.z = rad(-72); robin.tilt.rotation.x = -rad(rp); robin.head.rotation.set(rad(-0.35 * rp), 0, rad(ry), "ZXY");
    flies.forEach((b, i) => {                                       // butterflies: a wandering path, the body bobbing against each wing beat
      const path = (s: number) => V([0.9, -0.9, 0.2][i] + 0.6 * Math.sin(0.7 * s + i * 2.1) + 0.2 * Math.sin(2.3 * s + i), [0.3, -0.7, 2.4][i] + 0.5 * Math.sin(0.55 * s + i * 1.3) + 0.15 * Math.sin(1.9 * s),
        [0.55, 0.35, 1.0][i] + 0.14 * Math.sin(1.3 * s + i) + 0.05 * Math.sin(3.1 * s));
      const p = path(t), v = path(t + 0.02).sub(p), flap = Math.sin(TAU * (9.5 + i) * t + i);
      b.g.position.copy(p).add(V(0, 0, -0.012 * flap)); b.g.rotation.set(0.3, 0, Math.atan2(-v.x, v.y), "ZXY");
      b.wings.forEach((w, k) => (w.rotation.y = (k ? 1 : -1) * rad(28 + 52 * flap)));
    });
    MID.forEach((q, i) => {                                         // midges dancing in the sun beside the trunk
      m4.makeTranslation(0.35 + 0.8 * (q[0] - 0.5) + 0.12 * Math.sin(t * (2 + 3 * q[3]) + 9 * q[6]), 0.6 + 0.9 * (q[1] - 0.5) + 0.12 * Math.sin(t * (2 + 3 * q[4]) + 9 * q[7]),
        1.2 + 0.7 * (q[2] - 0.5) + 0.1 * Math.sin(t * (3 + 4 * q[5]) + 9 * q[8]));
      midges.setMatrixAt(i, m4);
    });
    midges.instanceMatrix.needsUpdate = true;
    for (const [o, f0, x, y, z0, ph] of drops) {                    // a leaf coming down: side to side, turning, then lying still
      const s = Math.max(fr - f0, 0) / 30, zg = gz(x, y) + 0.06, z = Math.max(z0 - 0.75 * s, zg), air = z > zg ? 1 : 0, sl = air ? s : (z0 - zg) / 0.75;
      o.position.set(x + 0.22 * Math.sin(2.6 * sl + ph), y + 0.1 * Math.sin(1.7 * sl + ph), z);
      o.rotation.set(0.9 * Math.sin(2.6 * sl + ph) * air + (1 - air) * 0.1, 2.2 * sl * air, 1.4 * sl + ph);
      o.visible = fr >= f0;
    }
    const k = fr / 239, L = (a: number[], b: number[]) => V(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
    const loc = L(CAM[0][1], CAM[1][1]);
    return { loc, tgt: L(CAM[0][2], CAM[1][2]), lens: CAM[0][3] + (CAM[1][3] - CAM[0][3]) * k, focus: loc.distanceTo(V(RABBIT.x, RABBIT.y, 0.12)) };
  }

  // render targets: one pass, the running mean, a small copy for the glow; then Blender's view transform
  const rtMain = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType });
  const rtAcc = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  const rtGlow = new THREE.WebGLRenderTarget(W / 4, H / 4, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const COPY = "uniform sampler2D tex; uniform float k; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tex, vUv).rgb * k, 1.0); }";
  const accMat = new THREE.ShaderMaterial({ uniforms: { tex: { value: rtMain.texture }, k: { value: 1 } }, vertexShader: QUAD_VS, fragmentShader: COPY,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest: false, depthWrite: false });
  const acc = new FullScreenQuad(accMat);
  const glow = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: { tex: { value: rtAcc.texture }, k: { value: 1 } }, vertexShader: QUAD_VS, fragmentShader: COPY, depthTest: false, depthWrite: false }));
  const outU = { tAcc: { value: rtAcc.texture }, tGlow: { value: rtGlow.texture }, tLut: { value: lut }, uExp: { value: 1.25 }, uSeed: { value: 0 } };
  const out = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: outU, vertexShader: QUAD_VS,
    fragmentShader: `precision highp sampler3D; uniform sampler2D tAcc, tGlow; uniform sampler3D tLut; uniform float uExp, uSeed; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tAcc, vUv).rgb, g = vec3(0.0);
  for (int k = 1; k <= 6; k++) g += textureLod(tGlow, vUv, float(k)).rgb;     // lens glow: a little of every blur width
  vec2 q = vUv - 0.5;
  c = mix(c, g / 6.0, 0.08) * uExp * (1.0 - 0.5 * dot(q, q));                  // + vignette
  vec3 u = clamp((log2(max(c, vec3(1e-10))) + 12.47393) / 16.499999, 0.0, 1.0);
  float n = fract(sin(dot(gl_FragCoord.xy + uSeed, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(texture(tLut, u * (64.0 / 65.0) + 0.5 / 65.0).rgb + (n - 0.5) * 0.014, 1.0);   // + a breath of grain
}`, depthTest: false, depthWrite: false }));

  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 3000);
  scene.add(cam);
  // haze: sheets of air across the view, facing the sun for the lighting, that take the sun's shadow like any surface.
  // Added up they are lit air with the shadows of the crown cut out of it: light shafts. Their depths shift every pass.
  const NS = 28, hzU = { value: new THREE.Vector4() }, sunVU = { value: V() }, hp: number[] = [];
  for (let i = 0; i < NS; i++) for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) hp.push(x, y, i);
  const hazeG = new THREE.BufferGeometry(); hazeG.setAttribute("position", new THREE.Float32BufferAttribute(hp, 3));
  const hazeM = new THREE.MeshLambertMaterial({ color: col([1.0, 0.9, 0.75], HAZE), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  hazeM.onBeforeCompile = (s) => {
    s.uniforms.uHz = hzU; s.uniforms.uSunV = sunVU;
    s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\nuniform vec4 uHz; uniform vec3 uSunV;")
      .replace("#include <begin_vertex>", "float hd = uHz.x + uHz.y * position.z; vec3 transformed = vec3(position.x * uHz.z * hd, position.y * uHz.w * hd, -hd);")
      .replace("#include <defaultnormal_vertex>", "vec3 transformedNormal = uSunV;");
  };
  const haze = new THREE.Mesh(hazeG, hazeM); haze.frustumCulled = false; haze.receiveShadow = true; haze.renderOrder = 10; cam.add(haze);
  const su = SUN.clone().cross(Z).normalize(), sv = SUN.clone().cross(su);
  return function render(fr: number, passes: number) {
    renderer.setRenderTarget(rtAcc); renderer.setClearColor(0x000000, 0); renderer.clear();
    for (let i = 0; i < passes; i++) {
      const hs = (b: number) => halton(i + 1, b);
      const c = update(fr + ((i + hs(2)) / passes - 0.5) * 0.5);   // shutter 0.5, centred on the frame
      const fwd = c.tgt.clone().sub(c.loc).normalize(), right = fwd.clone().cross(Z).normalize(), up = right.clone().cross(fwd);
      const lr = (c.lens / 1000 / (2 * 2.0)) * Math.sqrt(hs(3)), la = TAU * hs(5);   // f/2 aperture radius
      const eyeP = c.loc.clone().addScaledVector(right, lr * Math.cos(la)).addScaledVector(up, lr * Math.sin(la));
      cam.position.copy(b2t(eyeP)); cam.up.set(0, 1, 0); cam.lookAt(b2t(c.loc.clone().addScaledVector(fwd, c.focus)));
      cam.fov = (2 * Math.atan(12 / c.lens) * 180) / Math.PI;      // vertical sensor fit, 24 mm
      cam.setViewOffset(W, H, hs(7) - 0.5, hs(11) - 0.5, W, H);   // sub-pixel AA (also updates the projection)
      cam.updateMatrixWorld();
      const ty = Math.tan(rad(cam.fov) / 2) * 1.02;
      hzU.value.set(1.5 + 0.5 * hs(13), 0.5, ty * (W / H), ty);     // first sheet, spacing, half width and height per metre of depth
      sunVU.value.copy(b2t(SUN)).transformDirection(cam.matrixWorldInverse);
      const sr = 0.012 * Math.sqrt((i + 0.5) / passes), sa = TAU * ((i * 0.6180339887) % 1);        // a point on the sun's (widened) disk
      aim(sun, SUN.clone().addScaledVector(su, sr * Math.cos(sa)).addScaledVector(sv, sr * Math.sin(sa)).normalize());
      const z = 0.1 + 0.9 * (((i + 0.5) * 0.7548776662) % 1), a = TAU * (((i + 0.5) * 0.5698402910) % 1), q = Math.sqrt(1 - z * z);   // one sky direction
      const sd = V(q * Math.cos(a), q * Math.sin(a), z), sc = skyRad(sd);
      aim(skyL, sd); skyL.color.setRGB(sc[0], sc[1], sc[2]);
      renderer.shadowMap.needsUpdate = true;
      scene.updateMatrixWorld();
      renderer.setRenderTarget(rtMain); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, cam);
      accMat.uniforms.k.value = 1 / passes;
      renderer.setRenderTarget(rtAcc); acc.render(renderer);
    }
    renderer.setRenderTarget(rtGlow); glow.render(renderer);
    outU.uSeed.value = (fr * 17.31) % 1000;
    renderer.setRenderTarget(null); out.render(renderer);
  };
}

export const Js3dGarden: React.FC<{ passes?: number }> = ({ passes = 32 }) => {
  const frame = useCurrentFrame();
  const canvas = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<Promise<(fr: number, passes: number) => void> | null>(null);
  useLayoutEffect(() => {
    const h = delayRender(`garden frame ${frame}`);
    ctx.current ??= build(canvas.current!);
    ctx.current.then((render) => { render(frame, passes); continueRender(h); }).catch((e) => cancelRender(e));
  }, [frame, passes]);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <canvas ref={canvas} width={W} height={H} style={{ width: "100%", height: "100%" }} />
    </AbsoluteFill>
  );
};
