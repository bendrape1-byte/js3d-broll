import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AbsoluteFill, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";

// js3d-broll template (worked example): REEL-33's crash-test dummy grabbing a rebound and landing on "3-5 times your
// body weight", ported from Blender Cycles and matched to it (PSNR 31-33 dB per frame, geometry to the pixel).
// Copy this file into ~/claude-code/animations/src/<Client>/, keep the ENGINE parts (see SKILL.md), replace the scene.
// Everything is built in Blender's Z-up coordinates inside one group turned to three's Y-up (b2t converts a point).
// A frame is the mean of `passes` rasterised renders, each with its own shutter time (motion blur), lens point
// (depth of field), point on the key light's disk (soft shadows) and sub-pixel offset (AA): Cycles' sampling, but one
// sample is a whole GPU frame. Colour = Blender's AgX + "Medium High Contrast", baked into public/js3d/agx_mhc_65.bin.
// ponytail: no indirect bounce except a static environment probe.

const W = 1080, H = 1920, FRAMES = 150, HIT = 97;
type V3 = THREE.Vector3;
type M3 = THREE.Matrix3;
type Key = [number, number[]];
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const A = (a: number[]) => V(a[0], a[1], a[2]);
const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1);
const rad = (d: number) => (d * Math.PI) / 180;
const sm = (x: number) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };
const lin = (c: number[]) => c.map((x) => x ** 2.2);
const hexc = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const col = (c: number[], k = 1) => new THREE.Color().setRGB(c[0] * k, c[1] * k, c[2] * k, THREE.LinearSRGBColorSpace);
const BLUE = [0.2275, 0.7137, 0.9922];
const b2t = (v: V3) => V(v.x, v.z, -v.y);   // Blender (Z up) -> three (Y up), same as the root group's turn

// ---------------------------------------------------------------- mathutils equivalents (Matrix @ Vector = m.v)
const rotA = (axis: V3, a: number) => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationAxis(axis.clone().normalize(), a));
const rotX = (a: number) => rotA(X, a), rotY = (a: number) => rotA(Y, a), rotZ = (a: number) => rotA(Z, a);
const mm = (...m: M3[]) => m.reduce((a, b) => a.clone().multiply(b));
const mv = (m: M3, v: V3) => v.clone().applyMatrix3(m);
function frame(d: V3, ax: V3): M3 {          // columns (a, d, c): d along the bone, a = ax made perpendicular
  const dn = d.clone().normalize(), a = ax.clone().addScaledVector(dn, -ax.dot(dn)).normalize(), c = a.clone().cross(dn);
  return new THREE.Matrix3().set(a.x, dn.x, c.x, a.y, dn.y, c.y, a.z, dn.z, c.z);
}
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

// ---------------------------------------------------------------- geometry
function ring(c: V3, u: V3, v: V3, ru: number, rv: number, n = 28, p = 2.0): V3[] {
  const s = (x: number) => Math.sign(x) * Math.abs(x) ** (2 / p);
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return c.clone().addScaledVector(u, s(Math.cos(a)) * ru).addScaledVector(v, s(Math.sin(a)) * rv);
  });
}

function catmullClark(P: number[][], F: number[][]): [number[][], number[][]] {   // closed meshes only
  const nv = P.length;
  const avg = (q: number[][]) => [0, 1, 2].map((k) => q.reduce((s, p) => s + p[k], 0) / q.length);
  const fp = F.map((f) => avg(f.map((i) => P[i])));
  const key = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);
  const E = new Map<number, { a: number; b: number; f: number[]; i: number }>();
  F.forEach((f, fi) => f.forEach((a, k) => {
    const b = f[(k + 1) % f.length], e = E.get(key(a, b));
    if (e) e.f.push(fi); else E.set(key(a, b), { a, b, f: [fi], i: 0 });
  }));
  const edges = [...E.values()];
  const ep = edges.map((e, j) => { e.i = nv + j; return avg([P[e.a], P[e.b], fp[e.f[0]], fp[e.f[1] ?? e.f[0]]]); });
  const Q = P.map(() => [0, 0, 0]), R = P.map(() => [0, 0, 0]), nf = new Array(nv).fill(0), ne = new Array(nv).fill(0);
  F.forEach((f, fi) => f.forEach((i) => { for (let k = 0; k < 3; k++) Q[i][k] += fp[fi][k]; nf[i]++; }));
  for (const e of edges) for (const i of [e.a, e.b]) { for (let k = 0; k < 3; k++) R[i][k] += (P[e.a][k] + P[e.b][k]) / 2; ne[i]++; }
  const vp = P.map((p, i) => [0, 1, 2].map((k) => (Q[i][k] / nf[i] + (2 * R[i][k]) / ne[i] + (ne[i] - 3) * p[k]) / ne[i]));
  const f0 = nv + edges.length, NF: number[][] = [];
  F.forEach((f, fi) => f.forEach((v, k) => {
    const nx = f[(k + 1) % f.length], pv = f[(k + f.length - 1) % f.length];
    NF.push([v, E.get(key(v, nx))!.i, f0 + fi, E.get(key(pv, v))!.i]);
  }));
  return [[...vp, ...ep, ...fp], NF];
}

function toGeometry(P: number[][], F: number[][]) {
  const idx: number[] = [];
  for (const f of F) for (let k = 1; k < f.length - 1; k++) idx.push(f[0], f[k], f[k + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P.flat(), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function solid(rings: V3[][], poles: V3[], sub = 2) {
  const n = rings[0].length, last = (rings.length - 1) * n, p0 = rings.length * n;
  let P = [...rings.flat(), ...poles].map((q) => [q.x, q.y, q.z]);
  let F: number[][] = [];
  for (let r = 0; r < rings.length - 1; r++)
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; F.push([r * n + i, r * n + j, (r + 1) * n + j, (r + 1) * n + i]); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; F.push([j, i, p0], [last + i, last + j, p0 + 1]); }
  let vol = 0;                                                       // outward winding, like recalc_face_normals
  for (const f of F) for (let k = 1; k < f.length - 1; k++) vol += A(P[f[0]]).dot(A(P[f[k]]).cross(A(P[f[k + 1]])));
  if (vol < 0) F = F.map((f) => f.slice().reverse());
  for (let s = 0; s < sub; s++) [P, F] = catmullClark(P, F);
  return toGeometry(P, F);
}

function vseg(prof: number[][], a0: V3, b0: V3, side = 1, p = 2.0, caps = [0.6, 0.6], n = 28) {
  const a = a0, b = b0;
  const c = (z: number, dx: number, dy: number) => { const q = a.clone().lerp(b, (z - a.z) / (b.z - a.z)); return V(q.x + dx * side, q.y + dy, z); };
  const rings = prof.map(([z, rx, ry, dx, dy]) => ring(c(z, dx, dy), X, Y, rx, ry, n, p));
  const [z0, rx0, ry0, dx0, dy0] = prof[0], [z1, rx1, ry1, dx1, dy1] = prof[prof.length - 1];
  const h0 = caps[0] * Math.min(rx0, ry0), h1 = caps[1] * Math.min(rx1, ry1);
  const lo = [1.25, 0.9, 0.5].map((t) => ring(c(z0 - h0 * Math.sin(t), dx0, dy0), X, Y, rx0 * Math.cos(t), ry0 * Math.cos(t), n, p));
  const hi = [0.5, 0.9, 1.25].map((t) => ring(c(z1 + h1 * Math.sin(t), dx1, dy1), X, Y, rx1 * Math.cos(t), ry1 * Math.cos(t), n, p));
  return solid([...lo, ...rings, ...hi], [c(z0 - h0, dx0, dy0), c(z1 + h1, dx1, dy1)]);
}

function yseg(prof: number[][], side = 1, p = 2.6, caps = [0.5, 0.5], n = 28) {
  const c = (y: number, x: number, z: number) => V(x * side, y, z);
  const rings = prof.map(([y, rx, rz, x, z]) => ring(c(y, x, z), X, Z, rx, rz, n, p));
  const [y0, rx0, rz0, x0, zc0] = prof[0], [y1, rx1, rz1, x1, zc1] = prof[prof.length - 1];
  const h0 = caps[0] * Math.min(rx0, rz0), h1 = caps[1] * Math.min(rx1, rz1);
  const lo = [1.25, 0.9, 0.5].map((t) => ring(c(y0 + h0 * Math.sin(t), x0, zc0), X, Z, rx0 * Math.cos(t), rz0 * Math.cos(t), n, p));
  const hi = [0.5, 0.9, 1.25].map((t) => ring(c(y1 - h1 * Math.sin(t), x1, zc1), X, Z, rx1 * Math.cos(t), rz1 * Math.cos(t), n, p));
  return solid([...lo, ...rings, ...hi], [c(y0 + h0, x0, zc0), c(y1 - h1, x1, zc1)]);
}

function tube(pts: V3[], radii: number[], n = 14) {
  const rings = pts.map((q, i) => {
    const d = pts[Math.min(i + 1, pts.length - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize();
    const u = d.clone().cross(Math.abs(d.z) < 0.9 ? Z : X).normalize(), v = d.clone().cross(u);
    return ring(q, u, v, radii[i], radii[i], n);
  });
  const e = pts.length - 1, d0 = pts[1].clone().sub(pts[0]).normalize(), d1 = pts[e].clone().sub(pts[e - 1]).normalize();
  return solid(rings, [pts[0].clone().addScaledVector(d0, -radii[0] * 0.8), pts[e].clone().addScaledVector(d1, radii[e] * 0.8)]);
}

const sphere = (c: V3, r: number) => new THREE.SphereGeometry(r, 48, 24).translate(c.x, c.y, c.z);
const box = (c: number[], s: number[]) => new THREE.BoxGeometry(s[0], s[1], s[2]).translate(c[0], c[1], c[2]);

function discTarget(r: number, n = 32) {      // crash-test target: black/yellow quadrants in a black rim, facing +Z
  const pt = (k: number, rr: number) => [rr * Math.cos((2 * Math.PI * k) / n), rr * Math.sin((2 * Math.PI * k) / n), 0];
  const tri: number[][][] = [[], []];
  for (let i = 0; i < n; i++) {
    tri[Math.floor((i * 4) / n) % 2].push([0, 0, 0], pt(i, 0.86 * r), pt(i + 1, 0.86 * r));
    tri[0].push(pt(i, 0.86 * r), pt(i, r), pt(i + 1, r), pt(i, 0.86 * r), pt(i + 1, r), pt(i + 1, 0.86 * r));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([...tri[0], ...tri[1]].flat(), 3));
  g.computeVertexNormals();
  g.addGroup(0, tri[0].length, 0);
  g.addGroup(tri[0].length, tri[1].length, 1);
  return g;
}

// ---------------------------------------------------------------- materials (Principled -> MeshPhysical)
const mat = (c: number[], rough = 0.4, coat = 0, metal = 0) =>
  new THREE.MeshPhysicalMaterial({ color: col(lin(c)), roughness: rough, metalness: metal, clearcoat: coat, clearcoatRoughness: 0.12 });

// heat: glow around the load-bearing joints, in the dummy's rest coordinates (= every part's vertex positions)
const heatU = { value: new THREE.Vector4() };                       // Knee, Ankle, Hip, Back
function addHeat(m: THREE.MeshPhysicalMaterial) {
  m.onBeforeCompile = (s) => {
    s.uniforms.uHeat = heatU;
    s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vObj;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvObj = position;");
    s.fragmentShader = s.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vObj; uniform vec4 uHeat;
float g(vec3 c, float s, float k) { float d = distance(vObj, c) / s; return exp(-d * d) * k; }`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
float h = min(g(vec3(0.105, -0.02, 0.53), 0.085, uHeat.x) + g(vec3(-0.105, -0.02, 0.53), 0.085, uHeat.x)
  + g(vec3(0.11, 0.02, 0.11), 0.07, uHeat.y) + g(vec3(-0.11, 0.02, 0.11), 0.07, uHeat.y)
  + g(vec3(0.10, -0.02, 0.99), 0.075, uHeat.z) + g(vec3(-0.10, -0.02, 0.99), 0.075, uHeat.z)
  + g(vec3(0.0, 0.06, 1.14), 0.09, uHeat.w), 1.0);
vec3 ramp = h < 0.35 ? mix(vec3(0.0), vec3(0.55, 0.015, 0.0), h / 0.35)
  : h < 0.7 ? mix(vec3(0.55, 0.015, 0.0), vec3(1.0, 0.22, 0.015), (h - 0.35) / 0.35)
  : mix(vec3(1.0, 0.22, 0.015), vec3(1.0, 0.80, 0.42), (h - 0.7) / 0.3);
totalEmissiveRadiance = ramp * h * 7.0;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.01, 0.005), h);`);
  };
  return m;
}

type Mats = { body: THREE.Material; joint: THREE.Material; shoe: THREE.Material; sole: THREE.Material; mark: THREE.Material[] };
function styleMats(team: boolean, heat: boolean): Mats {
  const M = team
    ? { body: mat(hexc("#E8AE16"), 0.36, 0.35), joint: mat(hexc("#121212"), 0.55), shoe: mat(hexc("#161618"), 0.45), sole: mat(hexc("#F2F2F2"), 0.55) }
    : { body: mat(hexc("#34373D"), 0.4, 0.3), joint: mat(hexc("#0E0F11"), 0.6), shoe: mat(hexc("#F0F0F0"), 0.5), sole: mat(hexc("#0E0F11"), 0.6) };
  if (heat) { addHeat(M.body); addHeat(M.joint); }
  return { ...M, mark: [mat(hexc("#101010"), 0.5), mat(hexc("#F2C200"), 0.4)] };
}

// ---------------------------------------------------------------- the dummy
const LEFT: Record<string, number[]> = { shoulder: [0.20, 0.01, 1.55], elbow: [0.22, 0.03, 1.20], wrist: [0.23, 0.0, 0.92],
  tip: [0.235, -0.01, 0.73], hip: [0.10, 0.0, 1.00], knee: [0.105, -0.01, 0.53], ankle: [0.11, 0.02, 0.085], ball: [0.115, -0.15, 0.02] };
const mx = (p: number[], side: number) => V(p[0] * side, p[1], p[2]);
const BONES: [string, string | null, V3, V3][] = [["pelvis", null, V(0, 0, 1.0), V(0, 0, 1.12)], ["spine", "pelvis", V(0, 0, 1.12), V(0, 0, 1.30)],
  ["chest", "spine", V(0, 0, 1.30), V(0, 0, 1.60)], ["neck", "chest", V(0, 0.015, 1.60), V(0, 0.01, 1.72)], ["head", "neck", V(0, 0.01, 1.72), V(0, 0.01, 1.95)]];
for (const [side, x] of [[1, "L"], [-1, "R"]] as const) {
  const P = (k: string) => mx(LEFT[k], side);
  BONES.push([`upperarm.${x}`, "chest", P("shoulder"), P("elbow")], [`forearm.${x}`, `upperarm.${x}`, P("elbow"), P("wrist")],
    [`hand.${x}`, `forearm.${x}`, P("wrist"), P("tip")], [`thigh.${x}`, "pelvis", P("hip"), P("knee")],
    [`shin.${x}`, `thigh.${x}`, P("knee"), P("ankle")], [`foot.${x}`, `shin.${x}`, P("ankle"), P("ball")]);
}
const H0: Record<string, V3> = {}, Y0: Record<string, V3> = {}, PAR: Record<string, string | null> = {};
for (const [b, p, h, t] of BONES) { H0[b] = h; Y0[b] = t.clone().sub(h).normalize(); PAR[b] = p; }
const dist = (a: string, b: string) => A(LEFT[a]).distanceTo(A(LEFT[b]));
const L1 = dist("hip", "knee"), L2 = dist("knee", "ankle"), A1 = dist("shoulder", "elbow"), A2 = dist("elbow", "wrist");
const TOE = (side: number) => V(0.118 * side, -0.215, 0.004);       // front of the sole: the pivot on touchdown

const PELVIS = [[0.885, 0.072, 0.058, 0, 0.0], [0.905, 0.118, 0.086, 0, 0.0], [0.935, 0.150, 0.100, 0, 0.0], [0.975, 0.164, 0.108, 0, 0.0],
  [1.02, 0.166, 0.110, 0, 0.002], [1.07, 0.155, 0.106, 0, 0.005], [1.11, 0.140, 0.099, 0, 0.005]];
const ABDOMEN = [[1.15, 0.127, 0.094, 0, 0.004], [1.19, 0.125, 0.094, 0, 0.0], [1.24, 0.129, 0.097, 0, -0.003], [1.29, 0.136, 0.101, 0, -0.004]];
const WAIST = [[1.10, 0.121, 0.088, 0, 0.004], [1.16, 0.119, 0.088, 0, 0.004]];
const CHEST = [[1.305, 0.138, 0.102, 0, -0.004], [1.36, 0.150, 0.110, 0, -0.008], [1.43, 0.163, 0.120, 0, -0.012], [1.50, 0.172, 0.123, 0, -0.008],
  [1.55, 0.170, 0.115, 0, 0.0], [1.585, 0.150, 0.098, 0, 0.005], [1.61, 0.105, 0.075, 0, 0.008]];
const NECK = [[1.59, 0.054, 0.056, 0, 0.0], [1.65, 0.049, 0.052, 0, 0.0], [1.715, 0.046, 0.049, 0, 0.0]];
const HEAD = [[1.715, 0.042, 0.047, 0, -0.022], [1.735, 0.058, 0.066, 0, -0.018], [1.775, 0.071, 0.088, 0, -0.008], [1.83, 0.079, 0.100, 0, 0.0],
  [1.88, 0.080, 0.100, 0, 0.004], [1.925, 0.068, 0.086, 0, 0.006]];
const UPPERARM = [[1.24, 0.040, 0.042, 0, 0], [1.27, 0.042, 0.045, 0, 0], [1.34, 0.047, 0.051, 0, 0], [1.42, 0.052, 0.056, 0, 0], [1.49, 0.054, 0.058, 0, 0]];
const FOREARM = [[0.945, 0.020, 0.027, 0, 0], [0.98, 0.026, 0.031, 0, 0], [1.04, 0.033, 0.035, 0, 0], [1.10, 0.038, 0.038, 0, 0], [1.165, 0.037, 0.037, 0, 0]];
const PALM = [[0.80, 0.013, 0.043, 0, -0.004], [0.83, 0.016, 0.047, 0, -0.003], [0.87, 0.017, 0.046, 0, -0.002], [0.90, 0.014, 0.034, 0, 0]];
const FINGERS = [[0.725, 0.010, 0.032, -0.030, -0.006], [0.745, 0.011, 0.038, -0.020, -0.006], [0.77, 0.012, 0.042, -0.009, -0.005], [0.80, 0.013, 0.043, -0.002, -0.004]];
const CUPPED = [[0.735, 0.010, 0.034, -0.050, -0.006], [0.75, 0.011, 0.039, -0.034, -0.006], [0.775, 0.012, 0.043, -0.014, -0.005], [0.80, 0.013, 0.043, -0.002, -0.004]];
const THIGH = [[0.565, 0.051, 0.054, 0, 0.0], [0.61, 0.057, 0.061, 0, -0.004], [0.69, 0.066, 0.071, 0.004, -0.008], [0.79, 0.075, 0.080, 0.006, -0.010],
  [0.88, 0.080, 0.085, 0.004, -0.006], [0.955, 0.081, 0.086, 0, 0]];
const SHIN = [[0.14, 0.031, 0.034, 0, 0.01], [0.19, 0.035, 0.039, 0, 0.012], [0.27, 0.043, 0.049, 0, 0.015], [0.36, 0.051, 0.060, 0, 0.018],
  [0.43, 0.052, 0.060, 0, 0.012], [0.495, 0.048, 0.052, 0, 0.004]];
const SHOE = [[0.10, 0.030, 0.040, 0.110, 0.046], [0.085, 0.042, 0.054, 0.110, 0.058], [0.05, 0.047, 0.060, 0.110, 0.064], [0.0, 0.049, 0.058, 0.112, 0.062],
  [-0.06, 0.051, 0.050, 0.114, 0.054], [-0.12, 0.052, 0.038, 0.116, 0.042], [-0.175, 0.049, 0.030, 0.117, 0.034], [-0.21, 0.040, 0.025, 0.118, 0.029],
  [-0.228, 0.024, 0.018, 0.118, 0.024]];
const SOLE = SHOE.map(([y, rx, , x]) => [y + (y > 0 ? 0.006 : -0.006), rx + 0.004, 0.011, x, 0.011]);
const COLLAR = [[0.07, 0.050, 0.058, 0, 0], [0.12, 0.047, 0.054, 0, 0], [0.155, 0.043, 0.049, 0, 0]];

type Part = [THREE.BufferGeometry, keyof Omit<Mats, "mark">, string];   // geometry, material, bone
const partCache = new Map<boolean, Part[]>();
function parts(cupRight: boolean): Part[] {                          // built once, shared by every dummy
  const hit = partCache.get(cupRight);
  if (hit) return hit;
  const out: Part[] = [[vseg(PELVIS, V(0, 0, 0.88), V(0, 0, 1.13), 1, 2.3, [0.5, 0.25]), "body", "pelvis"],
    [vseg(WAIST, V(0, 0, 1.0), V(0, 0, 1.2), 1, 2.2, [0.2, 0.2]), "joint", "spine"],
    [vseg(ABDOMEN, V(0, 0, 1.12), V(0, 0, 1.30), 1, 2.2, [0.25, 0.25]), "body", "spine"],
    [vseg(CHEST, V(0, 0, 1.30), V(0, 0, 1.62), 1, 2.5, [0.25, 0.3]), "body", "chest"],
    [vseg(NECK, V(0, 0.015, 1.60), V(0, 0.01, 1.72), 1, 2.0, [0.3, 0.3]), "joint", "neck"],
    [vseg(HEAD, V(0, 0.01, 1.70), V(0, 0.01, 1.96), 1, 2.0, [0.3, 0.75], 32), "body", "head"]];
  for (const [side, x] of [[1, "L"], [-1, "R"]] as const) {
    const P = (k: string) => mx(LEFT[k], side);
    out.push([vseg(UPPERARM, P("shoulder"), P("elbow"), side, 2.0, [0.5, 0.5]), "body", `upperarm.${x}`],
      [sphere(P("shoulder"), 0.06), "body", `upperarm.${x}`], [sphere(P("elbow"), 0.037), "joint", `forearm.${x}`],
      [vseg(FOREARM, P("elbow"), P("wrist"), side, 2.0, [0.5, 0.5]), "body", `forearm.${x}`],
      [sphere(P("wrist"), 0.023), "joint", `hand.${x}`], [vseg(PALM, P("wrist"), P("tip"), side, 2.0, [0.5, 0.5]), "body", `hand.${x}`],
      [vseg(cupRight && side < 0 ? CUPPED : FINGERS, P("wrist"), P("tip"), side, 2.0, [0.5, 0.4]), "body", `hand.${x}`],
      [tube([mx([0.222, -0.035, 0.885], side), mx([0.212, -0.058, 0.855], side), mx([0.200, -0.072, 0.828], side)], [0.013, 0.012, 0.010]), "body", `hand.${x}`],
      [vseg(THIGH, P("hip"), P("knee"), side, 2.0, [0.5, 0.6]), "body", `thigh.${x}`], [sphere(P("knee"), 0.05), "joint", `shin.${x}`],
      [vseg(SHIN, P("knee"), P("ankle"), side, 2.0, [0.5, 0.5]), "body", `shin.${x}`], [sphere(P("ankle"), 0.034), "joint", `foot.${x}`],
      [yseg(SHOE, side), "shoe", `foot.${x}`], [yseg(SOLE, side, 3.0), "sole", `foot.${x}`],
      [vseg(COLLAR, V(0.11 * side, 0.025, 0.0), V(0.11 * side, 0.025, 1.0), side, 2.2, [0.3, 0.3]), "shoe", `foot.${x}`]);
  }
  partCache.set(cupRight, out);
  return out;
}

const ik = (Hh: V3, At: V3, pole: V3, l1: number, l2: number, arm = false) => {   // -> upper dir, lower dir, hinge, end
  const v = At.clone().sub(Hh), d = Math.min(v.length(), (l1 + l2) * 0.9995), u = v.clone().normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  const w = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
  const K = Hh.clone().addScaledVector(u, a).addScaledVector(w, h), end = Hh.clone().addScaledVector(u, d);
  return [K.clone().sub(Hh), end.clone().sub(K), (arm ? u.clone().cross(w) : w.clone().cross(u)).normalize(), end];
};
type ArmIK = { wrist: V3; pole: V3; h: V3; ax: V3 };

class Rig {
  group = new THREE.Group();
  world: THREE.Matrix4;
  meshes: [THREE.Mesh, string, THREE.Matrix4 | null][] = [];
  D: Record<string, M3> = {};
  head: Record<string, V3> = {};
  hand: Record<number, V3[]> = {};
  constructor(M: Mats, markers: boolean, cupRight: boolean, loc = V(), rz = 0) {
    this.world = new THREE.Matrix4().makeRotationZ(rad(rz)).setPosition(loc);
    const add = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], bone: string, rest: THREE.Matrix4 | null = null) => {
      const o = new THREE.Mesh(g, m);
      o.matrixAutoUpdate = false; o.castShadow = o.receiveShadow = true;
      this.group.add(o); this.meshes.push([o, bone, rest]);
    };
    const ps = parts(cupRight);
    for (const [g, m, bone] of ps) add(g, M[m], bone);
    if (!markers) return;
    const find = (bone: string, from: number[], d: V3) => {      // ray-cast the shell in its rest pose, like dummy.py
      const shells = ps.filter((p) => p[2] === bone && p[1] === "body").map((p) => new THREE.Mesh(p[0], new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
      const hits = new THREE.Raycaster(A(from), d).intersectObjects(shells);
      return hits[0];
    };
    for (const [from, d, bone] of [[[0.3, 0.0, 1.84], X.clone().negate(), "head"], [[-0.3, 0.0, 1.84], X, "head"],
      [[0.5, 0.03, 1.40], X.clone().negate(), "upperarm.L"], [[-0.5, 0.03, 1.40], X, "upperarm.R"],
      [[0.5, -0.02, 0.80], X.clone().negate(), "thigh.L"], [[-0.5, -0.02, 0.80], X, "thigh.R"]] as [number[], V3, string][]) {
      const h = find(bone, from, d);
      if (!h || !h.face) continue;
      const n = h.face.normal.clone().normalize();
      const yv = Z.clone().addScaledVector(n, -n.dot(Z)).normalize(), xv = yv.clone().cross(n);   // to_track_quat("Z", "Y")
      const rest = new THREE.Matrix4().makeBasis(xv, yv, n).setPosition(h.point.clone().addScaledVector(n, 0.0015));
      add(discTarget(bone === "head" ? 0.034 : 0.03), M.mark, bone, rest);
    }
  }

  delta(b: string, d: V3, ax: V3) { return mm(frame(d, ax), frame(Y0[b], X).transpose()); }

  /** root: hip centre. pitch: pelvis, spine, chest, neck forward (deg). arms: per side IK targets in the chest frame
   * or FK (flex, abd, twist, elbow, wrist) degrees. ankles / feet: per side ankle position and foot rotation. */
  pose(root: V3, pitch: number[], arms: Record<number, ArmIK | number[]>, ankles: Record<number, V3>, feet: Record<number, M3>) {
    const D = this.D, hd = this.head;
    let acc = new THREE.Matrix3();
    ["pelvis", "spine", "chest", "neck"].forEach((b, i) => { acc = mm(acc, rotX(rad(pitch[i]))); D[b] = acc.clone(); });
    D.head = D.neck;
    const headOf = (b: string) => { const p = PAR[b]!; return hd[p].clone().add(mv(D[p], H0[b].clone().sub(H0[p]))); };
    hd.pelvis = root.clone(); hd.spine = headOf("spine"); hd.chest = headOf("chest");
    const Dc = D.chest, C = hd.chest;
    for (const [side, x] of [[1, "L"], [-1, "R"]] as const) {
      const a = arms[side];
      if (!Array.isArray(a)) {
        const S = C.clone().add(mv(Dc, H0[`upperarm.${x}`].clone().sub(H0.chest)));
        const [up, fore, hinge, Wr] = ik(S, C.clone().add(mv(Dc, a.wrist)), mv(Dc, a.pole), A1, A2, true);
        const h = mv(Dc, a.h).normalize(), ax = mv(Dc, a.ax);
        D[`upperarm.${x}`] = this.delta(`upperarm.${x}`, up, hinge);
        D[`forearm.${x}`] = this.delta(`forearm.${x}`, fore, hinge);
        D[`hand.${x}`] = this.delta(`hand.${x}`, h, ax);
        this.hand[side] = [Wr, h, ax.clone().addScaledVector(h, -ax.dot(h)).normalize()];
      } else {
        const [fl, ab, tw, el, wr] = a.map(rad);
        const Rsh = mm(Dc, rotX(-fl), rotY(-ab * side));         // out first, then up: a raised arm stays out
        const up = mv(Rsh, V(0, 0, -1)), hinge = mv(rotA(up, tw * side), mv(Rsh, X));
        const fore = mv(rotA(hinge, -el), up), hand = mv(rotA(hinge, -wr), fore);
        D[`upperarm.${x}`] = this.delta(`upperarm.${x}`, up, hinge);
        D[`forearm.${x}`] = this.delta(`forearm.${x}`, fore, hinge);
        D[`hand.${x}`] = this.delta(`hand.${x}`, hand, hinge);
      }
      D[`foot.${x}`] = feet[side];
    }
    for (const [side, x] of [[1, "L"], [-1, "R"]] as const) {     // two-bone IK hip -> ankle, knee forward
      const Hh = root.clone().add(mv(D.pelvis, H0[`thigh.${x}`].clone().sub(H0.pelvis)));
      const pole = mv(D.pelvis, V(0.16 * side, -1, 0)); pole.z = 0; pole.normalize();
      const [th, sh, hinge] = ik(Hh, ankles[side], pole, L1, L2);
      D[`thigh.${x}`] = this.delta(`thigh.${x}`, th, hinge);
      D[`shin.${x}`] = this.delta(`shin.${x}`, sh, hinge);
    }
    for (const [b] of BONES.slice(1)) hd[b] = headOf(b);
    const bm = new THREE.Matrix4();
    for (const [o, b, rest] of this.meshes) {                       // part = world . T(head) . D . T(-rest head)
      bm.setFromMatrix3(D[b]).setPosition(hd[b].clone().sub(mv(D[b], H0[b])));
      o.matrix.multiplyMatrices(this.world, bm);
      if (rest) o.matrix.multiply(rest);
      o.matrixWorldNeedsUpdate = true;
    }
  }

  worldPos(b: string) { return this.head[b].clone().applyMatrix4(this.world); }
}

const footRot = (side: number, yaw: number, pitch: number, toeOut = 8) => mm(rotZ(rad(yaw + toeOut * side)), rotX(rad(pitch)));
const ankleFromToe = (side: number, toe: V3, R: M3) => toe.clone().add(mv(R, mx(LEFT.ankle, side).sub(TOE(side))));
const hipJoint = (root: V3, pitchDeg: number, side: number) => root.clone().add(mv(rotX(rad(pitchDeg)), mx(LEFT.hip, side).sub(V(0, 0, 1.0))));

// ---------------------------------------------------------------- motion (physical seconds: 0 = apex, TC = touchdown)
const TC = 0.40, G = 9.81, RB = 0.12, YC = 0.02;
const tau = (fr: number) => (fr <= HIT ? (TC * fr) / HIT : TC + (fr - HIT) / 30 / 4.0);   // ~8x slow motion, 4x after
const sink = (t: number) => { const k = 8.0, a = 0.22, b = G * TC - a * k; return a * (1 - Math.exp(-k * t)) + b * t * Math.exp(-k * t); };
const TOES: Record<number, V3> = { 1: V(0.17, -0.20, 0.004), [-1]: V(-0.15, -0.13, 0.004) };
const PITCH: Key[] = [[0, [6, 2, -4, -14]], [TC * 0.55, [8, 3, -2, 2]], [TC, [10, 3, 0, 12]], [TC + 0.23, [36, 10, 6, 6]], [TC + 0.5, [30, 8, 4, 0]]];
const R_WRIST: Key[] = [[0, [-0.273, -0.099, 0.842]], [TC * 0.45, [-0.32, -0.30, 0.68]], [TC * 0.8, [-0.30, -0.42, 0.42]], [TC, [-0.24, -0.40, 0.26]],
  [TC + 0.2, [-0.10, -0.33, 0.27]], [TC + 0.5, [-0.10, -0.33, 0.26]]];
const R_FINGERS: Key[] = [[0, [0, -0.15, 1]], [TC * 0.45, [0, -0.3, 1]], [TC * 0.8, [0.1, -0.35, 0.93]], [TC, [0.08, -0.3, 0.95]], [TC + 0.2, [0.05, -0.25, 0.97]],
  [TC + 0.5, [0.05, -0.25, 0.97]]];
const R_PALM: Key[] = [[0, [0.25, -0.95, 0.15]], [TC * 0.45, [0.35, -0.9, 0.2]], [TC * 0.8, [0.65, -0.75, 0.1]], [TC, [0.85, -0.5, 0.05]], [TC + 0.2, [0.92, -0.35, 0.0]],
  [TC + 0.5, [0.92, -0.35, 0.0]]];
const L_FREE: Key[] = [[0, [0.50, -0.05, -0.15]], [TC, [0.54, -0.11, -0.05]]];
const L_PALM_BALL = V(-0.92, -0.35, 0.0).normalize(), L_FINGERS_BALL = V(-0.05, -0.25, 0.97).normalize();
const TUCK: Record<number, [V3, number]> = { 1: [V(0.03, 0.06, -0.76), 38], [-1]: [V(-0.03, 0.12, -0.70), 42] };

const ZC = (() => {   // hip centre height at touchdown: both legs reach their touchdown ankle with the knee bent >= 18 deg
  const pitch = spline(TC, PITCH)[0], reach = Math.sqrt(L1 ** 2 + L2 ** 2 + 2 * L1 * L2 * Math.cos(rad(18)));
  return Math.min(...[1, -1].map((side) => {
    const Aa = ankleFromToe(side, TOES[side], footRot(side, 0, 20)), Hr = hipJoint(V(0, YC, 0), pitch, side);
    return Aa.z + Math.sqrt(reach ** 2 - Math.hypot(Hr.x - Aa.x, Hr.y - Aa.y) ** 2) - Hr.z;
  }));
})();

const CAM: [number, number[], number[], number][] = [[0, [-3.3, -3.6, 1.7], [0.05, 0.4, 2.35], 26], [55, [-2.7, -4.1, 1.25], [0.03, 0.2, 1.8], 27],
  [HIT, [-1.9, -3.75, 0.98], [0.0, 0.02, 1.15], 28], [FRAMES - 1, [-1.5, -3.4, 0.86], [0.0, 0.0, 1.0], 29]];

// ---------------------------------------------------------------- GLSL: floor wood (Blender's brick texture maths)
const C1 = lin([0.80, 0.58, 0.36]), C2 = lin([0.72, 0.49, 0.29]), CM = lin([0.30, 0.18, 0.09]);
const v3 = (c: number[]) => `vec3(${c.map((x) => x.toFixed(5)).join(", ")})`;
const WOOD = `
float brickNoise(uint n) {
  n = (n + 1013u) & 0x7fffffffu; n = (n >> 13u) ^ n;
  uint nn = (n * (n * n * 60493u + 19990303u) + 1376312589u) & 0x7fffffffu;
  return 0.5 * float(nn) / 1073741824.0;
}
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5, n = 0.0; for (int i = 0; i < 6; i++) { s += a * vnoise(p); n += a; p *= 2.0; a *= 0.5; } return s / n; }
vec3 wood(vec3 o) {
  vec2 p = vec2(-o.y, o.x);                       // mapping: rotated 90 deg, planks run along Y
  const float rh = 0.057, bw = 1.7, ms = 0.0012;
  float row = floor(p.y / rh), x = p.x + bw * 0.37, brick = floor(x / bw);
  x -= bw * brick; float y = p.y - rh * row;
  float tint = clamp(brickNoise((uint(int(row) + 100000) << 16) + (uint(int(brick) + 100000) & 0xFFFFu)), 0.0, 1.0);
  float md = min(min(x, y), min(bw - x, rh - y)), mortar = 0.0;
  if (md < ms) { md = 1.0 - md / ms; mortar = md < 0.3 ? smoothstep(0.0, 1.0, md / 0.3) : 1.0; }
  vec3 c = mix(mix(${v3(C1)}, ${v3(C2)}, tint), ${v3(CM)}, mortar);
  return c * (0.78 + 0.34 * fbm(vec3(o.x * 90.0, o.y * 2.5, o.z)));
}`;

const QUAD_VS = "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";
const halton = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

// court markings, drawn on a canvas: 20 x 20 m from (-10, -12), navy lane + white lines (alpha = paint coverage)
function courtTexture() {
  const n = 2048, k = n / 20, BX = 0.35, BY = 1.25, YB = BY + 1.575, YFT = YB - 5.8;
  const cv = document.createElement("canvas"); cv.width = cv.height = n;
  const c = cv.getContext("2d")!;
  c.setTransform(k, 0, 0, -k, 10 * k, 8 * k);                       // world metres -> pixels, y up, top edge at y = 8
  c.fillStyle = "rgba(13, 43, 79, 0.86)"; c.fillRect(BX - 2.45, YFT, 4.9, YB - YFT);   // lane paint (0.05, 0.17, 0.31)
  c.strokeStyle = "rgb(237, 237, 237)"; c.lineWidth = 0.05;
  const line = (pts: number[][]) => { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); c.stroke(); };
  const arc = (x: number, y: number, r: number, a0: number, a1: number) => { c.beginPath(); c.arc(x, y, r, a0, a1); c.stroke(); };
  line([[BX - 7.5, -12], [BX - 7.5, YB], [BX + 7.5, YB], [BX + 7.5, -12]]);               // sidelines + baseline
  line([[BX - 2.45, YB], [BX - 2.45, YFT], [BX + 2.45, YFT], [BX + 2.45, YB]]);           // lane + free-throw line
  arc(BX, YFT, 1.8, Math.PI, 2 * Math.PI);                                                 // free-throw circle (court side)
  arc(BX, BY, 1.25, Math.PI, 2 * Math.PI);                                                 // restricted area
  line([[BX - 1.25, BY], [BX - 1.25, BY + 0.375]]); line([[BX + 1.25, BY], [BX + 1.25, BY + 0.375]]);
  const a = Math.acos(6.6 / 6.75), y3 = BY - Math.sqrt(6.75 ** 2 - 6.6 ** 2);
  arc(BX, BY, 6.75, Math.PI + a, 2 * Math.PI - a);                                         // three-point arc
  line([[BX - 6.6, y3], [BX - 6.6, YB]]); line([[BX + 6.6, y3], [BX + 6.6, YB]]);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------- the whole scene
async function build(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true; renderer.shadowMap.autoUpdate = false;
  RectAreaLightUniformsLib.init();

  const lutBuf = await fetch(staticFile("js3d/agx_mhc_65.bin")).then((r) => r.arrayBuffer());
  const court = courtTexture(); court.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const N = 65, lf = new Float32Array(lutBuf), lh = new Uint16Array(N ** 3 * 4);
  for (let i = 0; i < N ** 3; i++) for (let k = 0; k < 4; k++) lh[i * 4 + k] = THREE.DataUtils.toHalfFloat(k < 3 ? lf[i * 3 + k] : 1);
  const lut = new THREE.Data3DTexture(lh, N, N, N);
  lut.type = THREE.HalfFloatType; lut.format = THREE.RGBAFormat; lut.unpackAlignment = 1;
  lut.minFilter = lut.magFilter = THREE.LinearFilter; lut.wrapS = lut.wrapT = lut.wrapR = THREE.ClampToEdgeWrapping; lut.needsUpdate = true;

  const scene = new THREE.Scene();
  scene.background = col([0.002, 0.003, 0.006]);
  const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);   // Blender Z up -> three Y up

  // court, hoop, arena
  const BX = 0.35, BY = 1.25, yb = BY + 0.375;
  const rtRefl = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    depthTexture: new THREE.DepthTexture(W, H) });
  const texMat = new THREE.Matrix4();
  const floorU = { tCourt: { value: court }, tRefl: { value: rtRefl.texture }, tReflDepth: { value: rtRefl.depthTexture }, uTex: { value: texMat },
    uRefl: { value: 0 }, uPxPerRad: { value: 1 }, uReflProjInv: { value: new THREE.Matrix4() }, uReflWorld: { value: new THREE.Matrix4() } };
  // All floor specular is the planar reflection (lights included as emitter quads, so the dummies occlude them like in
  // Cycles): coat 0.55 at roughness 0.07 and the base at 0.3 (the noise's mean), each a blur whose radius grows with
  // the distance from the floor to what it reflects (contact hardening), stretched along the view like GGX at grazing.
  const floorMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, specularIntensity: 0 });
  floorMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, floorU);
    s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\nuniform mat4 uTex; varying vec3 vObj; varying vec3 vW; varying vec4 vRc;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvObj = position; vW = (modelMatrix * vec4(position, 1.0)).xyz; vRc = uTex * vec4(vW, 1.0);");
    s.fragmentShader = s.fragmentShader.replace("#include <common>", `#include <common>
uniform sampler2D tCourt, tRefl, tReflDepth; uniform float uRefl, uPxPerRad; uniform mat4 uReflProjInv, uReflWorld;
varying vec3 vObj; varying vec3 vW; varying vec4 vRc;
${WOOD}
vec3 blur(vec2 uv, float rh, float rv) {             // radii in px: across (mip level) and along the view (taps)
  float lod = log2(max(2.0 * rh, 1.0));
  const float w[4] = float[4](0.271, 0.217, 0.111, 0.037);
  vec3 c = vec3(0.0);
  for (int k = -3; k <= 3; k++) c += textureLod(tRefl, uv + vec2(0.0, rv / ${H}.0 * float(k) / 3.0), lod).rgb * w[abs(k)];
  return c;
}
vec3 lobe(vec2 uv, float a, float g, float cv) {      // GGX: half of the energy within tan = a, 90 % within 3a, 99 % within 10a;
  float r = 2.0 * a * g;                              // a normal tilt t turns the ray 2t up/down but only 2t cos sideways
  return 0.5 * blur(uv, r * cv, r) + 0.4 * blur(uv, 3.0 * r * cv, 3.0 * r) + 0.1 * blur(uv, 10.0 * r * cv, 10.0 * r);
}`)
      .replace("#include <map_fragment>", `vec2 cuv = vObj.xy / 20.0 + vec2(0.5, 0.6);
vec4 ct = (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0) ? vec4(0.0) : texture2D(tCourt, cuv);
diffuseColor.rgb = mix(wood(vObj), ct.rgb, ct.a);`)
      .replace("#include <opaque_fragment>", `vec3 vv = cameraPosition - vW; float dc = length(vv), cv = clamp(vv.y / dc, 0.02, 1.0);
float si = sqrt(1.0 - cv * cv) / 1.5, cosT = sqrt(1.0 - si * si);   // dielectric Fresnel, IOR 1.5
float rs = (cv - 1.5 * cosT) / (cv + 1.5 * cosT), rp = (1.5 * cv - cosT) / (1.5 * cv + cosT), Fr = 0.5 * (rs * rs + rp * rp);
outgoingLight *= (1.0 - 0.55 * Fr) * (1.0 - 0.85 * Fr);   // rough base: its albedo is a bit under F
vec2 ruv = vRc.xy / vRc.w;
float z = texture2D(tReflDepth, ruv).r;
vec4 q = uReflProjInv * vec4(ruv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
float sd = z >= 1.0 ? 1e3 : distance((uReflWorld * (q / q.w)).xyz, vW);   // floor -> reflected point
float g = sd / (dc + sd) * uPxPerRad;                                    // px per radian of reflected ray here
outgoingLight += uRefl * (0.55 * Fr * lobe(ruv, 0.0049, g, cv) + (1.0 - 0.55 * Fr) * Fr * lobe(ruv, 0.09, g, cv));
#include <opaque_fragment>`);
  };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat);
  floor.receiveShadow = true; root.add(floor);

  const hoop = new THREE.Group(); root.add(hoop);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.03, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const white = mat([0.95, 0.95, 0.95], 0.4), orange = mat([0.95, 0.28, 0.06], 0.32, 0, 0.6), dark = mat([0.05, 0.055, 0.06], 0.55);
  const hm = (g: THREE.BufferGeometry, m: THREE.Material) => { const o = new THREE.Mesh(g, m); o.castShadow = o.receiveShadow = true; hoop.add(o); return o; };
  hm(box([BX, yb + 0.015, 3.425], [1.8, 0.03, 1.05]), glass).castShadow = false;
  for (const [c, s] of [[[BX, yb - 0.003, 3.925], [1.8, 0.006, 0.05]], [[BX, yb - 0.003, 2.925], [1.8, 0.006, 0.05]],
    [[BX - 0.875, yb - 0.003, 3.425], [0.05, 0.006, 1.05]], [[BX + 0.875, yb - 0.003, 3.425], [0.05, 0.006, 1.05]],
    [[BX, yb - 0.003, 3.075], [0.59, 0.006, 0.05]], [[BX, yb - 0.003, 3.475], [0.59, 0.006, 0.05]],
    [[BX - 0.27, yb - 0.003, 3.25], [0.05, 0.006, 0.45]], [[BX + 0.27, yb - 0.003, 3.25], [0.05, 0.006, 0.45]]]) hm(box(c, s), white);
  hm(new THREE.TorusGeometry(0.2286, 0.0095, 12, 72).translate(BX, BY, 3.05), orange);
  hm(box([BX, BY + 0.30, 3.03], [0.12, 0.16, 0.06]), orange);
  hm(box([BX, yb + 0.45, 3.6], [0.12, 0.9, 0.12]), dark);
  hm(box([BX, yb + 0.9, 7.0], [0.12, 0.12, 7.0]), dark);
  const pt = (k: number, i: number) => V(BX + (0.222 - k * 0.013) * Math.cos(rad((i + 0.5 * (k % 2)) * 30)),
    BY + (0.222 - k * 0.013) * Math.sin(rad((i + 0.5 * (k % 2)) * 30)), 3.04 - k * 0.075);
  const strands: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) for (let i = 0; i < 12; i++) for (const j of [i, k % 2 === 0 ? (i + 11) % 12 : (i + 1) % 12]) {
    const a = pt(k, i), b = pt(k + 1, j), g = new THREE.CylinderGeometry(0.0035, 0.0035, a.distanceTo(b), 6, 1, true);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize())).translate(...a.clone().lerp(b, 0.5).toArray());
    strands.push(g);
  }
  hm(mergeGeometries(strands), mat([0.93, 0.93, 0.92], 0.7)).receiveShadow = false;

  const ledBase = new THREE.MeshBasicMaterial({ color: col([0.010, 0.016, 0.030]) });
  const ledTop = new THREE.MeshBasicMaterial({ color: col([0.30, 0.33, 0.38]) });
  root.add(new THREE.Mesh(box([BX, 6.2, 0.43], [26, 0.15, 0.86]), ledBase), new THREE.Mesh(box([BX, 6.2, 0.88], [26, 0.15, 0.04]), ledTop));
  const stands = new THREE.BufferGeometry().setFromPoints([V(-40, 9, 0.5), V(40, 9, 0.5), V(40, 34, 17), V(-40, 9, 0.5), V(40, 34, 17), V(-40, 34, 17)]);
  stands.computeVertexNormals();
  root.add(new THREE.Mesh(stands, new THREE.MeshStandardMaterial({ color: col([0.015, 0.016, 0.02]), roughness: 0.8, side: THREE.DoubleSide })));

  // lights, in Cycles units (measured with a calibration render): point/spot intensity P / 4pi, area radiance P / (pi area);
  // three's penumbra 0.41 = Blender's spot blend 0.65 (rms 0.004 along the floor)
  const key = new THREE.SpotLight(col([1.0, 0.93, 0.84]), 9000 / (4 * Math.PI), 0, rad(29), 0.41, 2);
  const KEY = V(-0.6, -1.2, 9.5), KEYT = V(0, 0, 0.6);
  key.position.copy(KEY); key.target.position.copy(KEYT); root.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.camera.near = 3; key.shadow.camera.far = 14;
  key.shadow.bias = -0.0002; key.shadow.normalBias = 0.012;
  const emitters = new THREE.Group(); scene.add(emitters);          // area lights as seen in the floor's reflection
  const area = (loc: number[], tgt: number[], P: number, size: number, c: number[], camera = true) => {
    const L = P / (Math.PI * size * size), l = new THREE.RectAreaLight(col(c), L, size, size);
    l.position.copy(b2t(A(loc))); l.lookAt(b2t(A(tgt))); scene.add(l);
    const e = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: col(c, L) }));
    e.position.copy(l.position); e.lookAt(b2t(A(tgt))); e.visible = camera; emitters.add(e);
    return l;
  };
  area([-1.2, -1.6, 8.5], [0, 0, 0.8], 500, 5.0, [1.0, 0.94, 0.86]);   // Soft
  area([2.8, 4.5, 3.6], [0, 0, 1.4], 450, 2.5, lin(BLUE));             // Rim (hidden from camera, seen by the floor)
  area([-4.0, -6.5, 2.2], [0, 0, 1.2], 110, 4.0, [0.85, 0.9, 1.0]);    // Fill
  const uplight = new THREE.PointLight(col(lin(BLUE)), 0, 0, 2);       // the floor flash lighting the shoes and shins
  uplight.position.set(0.01, -0.06, -0.25); root.add(uplight);         // under the floor: lights only what is above it

  // dummies and ball
  const MAIN = new Rig(styleMats(true, true), true, true);
  const DEF = new Rig(styleMats(false, false), false, false, V(2.5, 1.6, 0), -50);
  const MATE = new Rig(styleMats(true, false), true, false, V(-1.75, 2.3, 0), 150);
  const actors = new THREE.Group(); root.add(actors);
  actors.add(MAIN.group, DEF.group, MATE.group);
  const ballMat = new THREE.MeshPhysicalMaterial({ roughness: 0.55 });
  ballMat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vObj;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvObj = position;");
    s.fragmentShader = s.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vObj; float seam(float v) { return clamp((abs(v) - 0.032) / (0.022 - 0.032), 0.0, 1.0); }`)
      .replace("#include <map_fragment>", `vec3 bq = vObj / 0.12;
diffuseColor.rgb = mix(${v3(lin([0.82, 0.36, 0.13]))}, vec3(0.012, 0.01, 0.01), max(max(seam(bq.x), seam(bq.z)), seam(abs(bq.y) - 0.64)));`);
  };
  const ball = new THREE.Mesh(new THREE.SphereGeometry(RB, 64, 32), ballMat);
  ball.matrixAutoUpdate = false; ball.castShadow = ball.receiveShadow = true; actors.add(ball);

  const fx = new THREE.Group(); root.add(fx);
  const rings = [0, 1].map(() => {
    const o = new THREE.Mesh(new THREE.RingGeometry(0.955, 1.0, 96), new THREE.MeshBasicMaterial({ color: col(lin(BLUE), 12), transparent: true, opacity: 0, depthWrite: false }));
    o.position.set(0.01, -0.06, 0.003); fx.add(o); return o;
  });
  const flashU = { value: 0 };
  const flash = new THREE.Mesh(new THREE.CircleGeometry(0.9, 64), new THREE.ShaderMaterial({
    uniforms: { uA: flashU, uC: { value: col(lin(BLUE), 6) } }, transparent: true, depthWrite: false,
    vertexShader: "varying vec3 vObj; void main() { vObj = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "uniform float uA; uniform vec3 uC; varying vec3 vObj; void main() { gl_FragColor = vec4(uC, uA * pow(max(1.0 - length(vObj), 0.0), 3.0)); }",
  }));
  flash.position.set(0.01, -0.06, 0.002); fx.add(flash);

  // ---------------------------------------------------------------- animation (a pure function of the frame)
  function mainPose(t: number) {
    const pitch = spline(t, PITCH), ankles: Record<number, V3> = {}, feet: Record<number, M3> = {};
    let root0: V3;
    if (t <= TC) {
      root0 = V(0, YC + 0.22 * (1 - t / TC), ZC + 0.5 * G * (TC ** 2 - t ** 2));
      const e = sm((t - 0.10) / (TC - 0.10));
      for (const side of [1, -1]) {
        const [off, p0] = TUCK[side], Ac = ankleFromToe(side, TOES[side], footRot(side, 0, 20));
        const Hc = hipJoint(V(0, YC, ZC), spline(TC, PITCH)[0], side), Hh = hipJoint(root0, pitch[0], side);
        ankles[side] = Hh.add(off.clone().lerp(Ac.sub(Hc), e));
        feet[side] = footRot(side, 0, p0 + (20 - p0) * e);
      }
    } else {
      const tt = t - TC;
      root0 = V(0, YC + 0.08 * sm(tt / 0.3), ZC - sink(tt));
      for (const side of [1, -1]) { const R = footRot(side, 0, 20 * (1 - sm(tt / 0.07))); ankles[side] = ankleFromToe(side, TOES[side], R); feet[side] = R; }
    }
    const S = (ks: Key[]) => A(spline(t, ks));
    const rw = S(R_WRIST), rh = S(R_FINGERS).normalize(), rp = S(R_PALM).normalize();
    const onBall = rw.clone().addScaledVector(rh, 0.075).addScaledVector(rp, RB + 0.016).addScaledVector(L_PALM_BALL, -(RB + 0.016)).addScaledVector(L_FINGERS_BALL, -0.075);
    const b = sm((t - TC + 0.10) / 0.22);
    MAIN.pose(root0, pitch, {
      [-1]: { wrist: rw, pole: V(-0.7, 0.45, -0.55), h: rh, ax: rp },
      1: { wrist: S(L_FREE).lerp(onBall, b), pole: V(0.7, 0.45, -0.55), h: V(0.6, -0.2, -0.75).normalize().lerp(L_FINGERS_BALL, b), ax: V(0, -0.2, 1).lerp(L_PALM_BALL.clone().negate(), b) },
    }, ankles, feet);
    const [Wr, h, ax] = MAIN.hand[-1];
    ball.matrix.copy(MAIN.world).multiply(new THREE.Matrix4().setFromMatrix3(frame(h, ax)).setPosition(Wr.clone().addScaledVector(h, 0.075).addScaledVector(ax, RB + 0.016)));
    ball.matrixWorldNeedsUpdate = true;
  }
  function standPose(rig: Rig, fr: number, z: number, pitch: number, arm: number[], armR: number[], phase: number) {
    const w = Math.sin(2 * Math.PI * ((fr / 30) * 0.35 + phase));
    const feet: Record<number, M3> = { 1: footRot(1, 0, 0, 12), [-1]: footRot(-1, 0, 0, 12) };
    const ankles: Record<number, V3> = { 1: ankleFromToe(1, V(0.17, -0.19, 0.004), feet[1]), [-1]: ankleFromToe(-1, V(-0.17, -0.19, 0.004), feet[-1]) };
    const a = (q: number[]) => [q[0] + 4 * w, q[1], q[2], q[3] - 3 * w, q[4]];
    rig.pose(V(0, 0.04, z + 0.008 * w), [pitch, 4, 2, -6], { 1: a(arm), [-1]: a(armR) }, ankles, feet);
  }
  function update(fr: number) {
    mainPose(tau(fr));
    const k = sm((fr - 50) / 70);
    standPose(DEF, fr, 0.84, 22, [150 - 90 * k, 35 + 15 * k, 0, 15 + 25 * k, 10], [28, 30, 0, 35, 10], 0.0);   // far arm up and out
    standPose(MATE, fr, 0.88, 18, [55, 48, 0, 40, 5], [55, 48, 0, 40, 5], 0.4);
    const x = fr - HIT;
    rings.forEach((o, i) => {
      const u = (x - 4 * i) / 22.0, r = 0.18 + 1.5 * (1 - (1 - Math.min(Math.max(u, 0), 1)) ** 3);
      o.scale.set(r, r, 1);
      (o.material as THREE.MeshBasicMaterial).opacity = u < 0 ? 0 : (1 - Math.min(u, 1)) ** 2 * (1 - 0.4 * i);
    });
    flashU.value = x < 0 ? 0 : Math.exp(-x / 5.0);
    uplight.intensity = 1.2 * flashU.value + 0.6 * (rings[0].material as THREE.MeshBasicMaterial).opacity;
    const hk = x < 0 ? 0 : (1 - (1 - Math.min(x / 10, 1)) ** 2) * (1 - 0.18 * sm((x - 25) / 28));
    heatU.value.set(hk * 1.0, hk * 0.8, hk * 0.4, hk * 0.3);
    let loc = A(spline(fr, CAM.map((c) => [c[0], c[1]] as Key))), tgt = A(spline(fr, CAM.map((c) => [c[0], c[2]] as Key)));
    const lens = spline(fr, CAM.map((c) => [c[0], [c[3]]] as Key))[0];
    if (fr > HIT) {                                                  // impact shake, gone in ~0.4 s
      const sh = V(Math.sin(fr * 2.1), Math.cos(fr * 2.7) * 0.6, Math.sin(fr * 3.3 + 1) * 0.8).multiplyScalar(0.03 * Math.exp(-(fr - HIT) / 4.5));
      loc = loc.add(sh); tgt = tgt.addScaledVector(sh, 0.4);
    }
    return { loc, tgt, lens, focus: MAIN.worldPos("chest").distanceTo(loc) };
  }

  // environment probe for the dummies' reflections and floor bounce (static arena, lit, no actors)
  actors.visible = fx.visible = emitters.visible = false;
  key.shadow.needsUpdate = true; renderer.shadowMap.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0, 0.05, 80, { size: 256, position: b2t(V(0, 0, 1.2)) }).texture;
  pmrem.dispose();
  actors.visible = fx.visible = true;
  for (const r of [MAIN, DEF, MATE]) for (const [o] of r.meshes) for (const m of [o.material].flat()) (m as THREE.MeshPhysicalMaterial).envMap = env;
  for (const m of [ballMat, glass, white, orange, dark]) m.envMap = env;
  floorU.uRefl.value = 1;

  // render targets: one pass, its reflection, the running mean; then Blender's view transform
  const rtMain = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType });
  const rtAcc = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
  const accMat = new THREE.ShaderMaterial({ uniforms: { tex: { value: rtMain.texture }, k: { value: 1 } }, vertexShader: QUAD_VS,
    fragmentShader: "uniform sampler2D tex; uniform float k; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tex, vUv).rgb * k, 1.0); }",
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest: false, depthWrite: false });
  const acc = new FullScreenQuad(accMat);
  const out = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: { tAcc: { value: rtAcc.texture }, tLut: { value: lut } }, vertexShader: QUAD_VS,
    fragmentShader: `precision highp sampler3D; uniform sampler2D tAcc; uniform sampler3D tLut; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tAcc, vUv).rgb;
  vec3 u = clamp((log2(max(c, vec3(1e-10))) + 12.47393) / 16.499999, 0.0, 1.0);
  gl_FragColor = vec4(texture(tLut, u * (64.0 / 65.0) + 0.5 / 65.0).rgb, 1.0);
}`, depthTest: false, depthWrite: false }));

  const cam = new THREE.PerspectiveCamera(50, W / H, 0.05, 120), reflCam = new THREE.PerspectiveCamera();
  scene.add(cam);
  const reflect = (p: V3, n: V3) => p.clone().addScaledVector(n, -2 * p.dot(n));   // mirror through the origin
  function mirror(n: V3) {                                           // three's Reflector maths, for a plane through 0
    const cp = V().setFromMatrixPosition(cam.matrixWorld), rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    reflCam.position.copy(reflect(cp, n));
    reflCam.up.copy(reflect(V(0, 1, 0).applyMatrix4(rot), n));
    reflCam.lookAt(reflect(V(0, 0, -1).applyMatrix4(rot).add(cp), n));
    reflCam.near = cam.near; reflCam.far = cam.far; reflCam.aspect = W / H;     // wider than the shot: glossy lobes reach
    reflCam.fov = (2 * Math.atan(2 * Math.tan(rad(cam.fov) / 2)) * 180) / Math.PI;   // lights outside the frame (the rim)
    reflCam.updateProjectionMatrix(); reflCam.updateMatrixWorld();
    texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse);
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, V()).applyMatrix4(reflCam.matrixWorldInverse);
    const clip = new THREE.Vector4(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant), e = reflCam.projectionMatrix.elements;
    const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - 0.003; e[14] = clip.w;
    reflCam.projectionMatrixInverse.copy(reflCam.projectionMatrix).invert();
  }
  const axis = KEYT.clone().sub(KEY).normalize(), ku = axis.clone().cross(X).normalize(), kv = axis.clone().cross(ku);


  return function render(fr: number, passes: number) {
    renderer.setRenderTarget(rtAcc); renderer.setClearColor(0x000000, 0); renderer.clear();
    for (let i = 0; i < passes; i++) {
      const hs = (b: number) => halton(i + 1, b);
      const c = update(fr + ((i + hs(2)) / passes - 0.5) * 0.5);   // shutter 0.5, centred on the frame
      const fwd = c.tgt.clone().sub(c.loc).normalize(), right = fwd.clone().cross(Z).normalize(), up = right.clone().cross(fwd);
      const lr = (c.lens / 1000 / (2 * 2.0)) * Math.sqrt(hs(3)), la = 2 * Math.PI * hs(5);   // f/2 aperture radius
      const eye = c.loc.clone().addScaledVector(right, lr * Math.cos(la)).addScaledVector(up, lr * Math.sin(la));
      cam.position.copy(b2t(eye)); cam.up.set(0, 1, 0); cam.lookAt(b2t(c.loc.clone().addScaledVector(fwd, c.focus)));
      cam.fov = (2 * Math.atan(12 / c.lens) * 180) / Math.PI;      // vertical sensor fit, 24 mm
      cam.setViewOffset(W, H, hs(7) - 0.5, hs(11) - 0.5, W, H);   // sub-pixel AA (also updates the projection)
      cam.updateMatrixWorld();
      const kr = 0.7 * Math.sqrt(hs(13)), ka = 2 * Math.PI * hs(17);   // point on the key light's disk
      const ko = ku.clone().multiplyScalar(kr * Math.cos(ka)).addScaledVector(kv, kr * Math.sin(ka));
      key.position.copy(KEY).add(ko); key.target.position.copy(KEYT).add(ko);
      key.shadow.needsUpdate = true; renderer.shadowMap.needsUpdate = true;
      scene.updateMatrixWorld();
      mirror(V(0, 1, 0));
      floorU.uPxPerRad.value = H / rad(reflCam.fov);
      floorU.uReflProjInv.value.copy(reflCam.projectionMatrixInverse); floorU.uReflWorld.value.copy(reflCam.matrixWorld);
      floor.visible = false; fx.visible = false; emitters.visible = true;
      renderer.setRenderTarget(rtRefl); renderer.setClearColor(scene.background as THREE.Color, 1); renderer.clear(); renderer.render(scene, reflCam);
      floor.visible = true; fx.visible = true; emitters.visible = false;
      renderer.setRenderTarget(rtMain); renderer.clear(); renderer.render(scene, cam);
      accMat.uniforms.k.value = 1 / passes;
      renderer.setRenderTarget(rtAcc); acc.render(renderer);
    }
    renderer.setRenderTarget(null); out.render(renderer);
  };
}

export const Js3dDummy: React.FC<{ passes?: number }> = ({ passes = 32 }) => {
  const frame = useCurrentFrame();
  const canvas = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<Promise<(fr: number, passes: number) => void> | null>(null);
  useLayoutEffect(() => {
    const h = delayRender(`dummy frame ${frame}`);
    ctx.current ??= build(canvas.current!);
    ctx.current.then((render) => { render(frame, passes); continueRender(h); }).catch((e) => cancelRender(e));
  }, [frame, passes]);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <canvas ref={canvas} width={W} height={H} style={{ width: "100%", height: "100%" }} />
    </AbsoluteFill>
  );
};
