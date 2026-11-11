// garden_sound.mjs <events.json> <out.wav> [mix.json]: the garden clip's sound, timed by the scene's own numbers.
// events.json comes out of the scene itself (prop `events`, see SKILL.md "Sound"): every contact with its time,
// speed, place on screen and distance, and the wind strength per frame.
// Without mix.json everything is computed: a thump is a falling sine plus noise bursts, a hop or a peck a few
// milliseconds of filtered noise. That is exact in time but reads as drum hits and clicks, and code cannot do wind
// in leaves at all (four tries read as surf, fire or static to earshot). So mix.json names recordings to use instead:
//   { "bed":   { "file": "x.wav", "from": 2.5, "gain": 4, "swing": 6 },      an ambience; its level follows wind.tree by +-swing/2 dB
//     "songs": [{ "file": "y.wav", "from": 1.35, "to": 3.25, "at": 0.2, "gain": -22, "pan": 0.6 }],   a phrase placed at `at` seconds
//     "thud":  { "file": "z.wav" } }                                          replaces the computed apple thump, cut to its onset
// gain in dB, times in seconds, files relative to mix.json, all 16-bit WAV at 48 kHz (ffmpeg -i x.ogg -ar 48000 -c:a pcm_s16le x.wav).
// Same input, same file, sample for sample. Also writes <out>.cues.json (time, kind, id of every event).
// Node only, no packages:  node garden_sound.mjs garden_events.json garden_sound.wav [garden_sound_mix.json]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [evPath, outPath, mixPath] = process.argv.slice(2);
if (!evPath || !outPath) { console.error("usage: node garden_sound.mjs <events.json> <out.wav> [mix.json]"); process.exit(1); }
const ev = JSON.parse(readFileSync(evPath, "utf8")), mix = mixPath ? JSON.parse(readFileSync(mixPath, "utf8")) : {};
const SR = 48000, N = Math.round((ev.frames / ev.fps) * SR), L = new Float32Array(N), R = new Float32Array(N);

let seed = 20261111;                                     // mulberry32: repeatable random numbers
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const noise = (n) => Float32Array.from({ length: n }, () => rnd() * 2 - 1);

/** One second-order filter (RBJ cookbook) run over x in place. type: lp (low-pass), hp (high-pass), bp (band-pass). */
function filt(x, type, f, q) {
  const w = (2 * Math.PI * f) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const [b0, b1, b2] = type === "lp" ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : type === "hp" ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [al, 0, -al];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 + 2 * c * y1 - (1 - al) * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const dB = (g) => 10 ** (g / 20);
/** a 16-bit PCM WAV at 48 kHz -> one Float32Array per channel */
function readWav(file) {
  const b = readFileSync(resolve(dirname(mixPath), file)); let p = 12, fmt = -1, at = -1, len = 0;
  while (p < b.length - 8 && at < 0) { const id = b.toString("ascii", p, p + 4), n = b.readUInt32LE(p + 4); if (id === "fmt ") fmt = p + 8; if (id === "data") { at = p + 8; len = Math.min(n, b.length - at); } p += 8 + n + (n & 1); }
  if (fmt < 0 || at < 0 || b.readUInt16LE(fmt) !== 1 || b.readUInt32LE(fmt + 4) !== SR || b.readUInt16LE(fmt + 14) !== 16) throw new Error(`${file}: need a 16-bit PCM WAV at ${SR} Hz`);
  const ch = b.readUInt16LE(fmt + 2), n = Math.floor(len / (2 * ch));
  return Array.from({ length: ch }, (_, c) => Float32Array.from({ length: n }, (_, i) => b.readInt16LE(at + (i * ch + c) * 2) / 32768));
}
const mono = (ch) => ch[0].map((v, i) => ch.reduce((s, c) => s + c[i], 0) / ch.length);
const faded = (x, n = 960) => x.map((v, i) => v * Math.min(1, i / n, (x.length - 1 - i) / n));   // 20 ms in and out: no click at a cut

// ---- the bed: a recorded ambience, as long as the clip, its level riding the wind that moves the tree in the picture
if (mix.bed) {
  const ch = readWav(mix.bed.file), i0 = Math.round((mix.bed.from ?? 0) * SR), g = dB(mix.bed.gain ?? 0), swing = mix.bed.swing ?? 6, a = ev.wind.tree;
  if (ch[0].length < i0 + N) throw new Error(`${mix.bed.file}: too short for ${N / SR} s from ${mix.bed.from} s`);
  for (let i = 0; i < N; i++) {
    const u = (i / SR) * ev.fps, k = Math.min(Math.floor(u), a.length - 2), wind = a[k] + (a[k + 1] - a[k]) * (u - k);   // 0 calm .. 1 strongest gust
    const gain = g * dB(swing * (wind - 0.5)) * Math.min(1, i / 480, (N - 1 - i) / 480);
    L[i] += ch[0][i0 + i] * gain; R[i] += ch[ch.length - 1][i0 + i] * gain;
  }
}

// ---- contacts. Each is a short mono sound placed at its time, panned by where it is on screen, quieter with distance.
function place(x, t, pan, gain) {
  const i0 = Math.round(t * SR), a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  for (let i = 0; i < x.length && i0 + i < N; i++) { L[i0 + i] += x[i] * gl; R[i0 + i] += x[i] * gr; }
}
const burst = (len, decay, type, f, q) => filt(noise(Math.round(len * SR)), type, f, q).map((v, i) => v * Math.exp(-i / SR / decay));
const SOUND = {
  // an apple on turf: the ground gives (a sine falling from ~115 to 55 Hz), the turf crunches (dull noise), blades flick (bright, very short)
  apple: (v) => {
    const n = Math.round(0.3 * SR), x = new Float32Array(n), crunch = burst(0.3, 0.03, "lp", 900, 0.7), flick = burst(0.3, 0.012, "hp", 2500, 0.7);
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; ph += (2 * Math.PI * (55 + 60 * Math.exp(-t / 0.02))) / SR; x[i] = Math.sin(ph) * Math.exp(-t / 0.06) + 0.9 * crunch[i] + 0.25 * flick[i]; }
    return [x, 0.3 * Math.min(1, v / 4)];                 // louder the faster it lands, full level from 4 m/s
  },
  hop: () => [burst(0.06, 0.008, "bp", 1200, 1.5), 0.12],        // a bird's feet in grass
  "hop stone": () => [burst(0.05, 0.005, "bp", 2800, 2.5), 0.12],   // ... on stone: brighter, shorter
  peck: () => [burst(0.03, 0.003, "bp", 3600, 4), 0.12],        // a beak on stone
};
if (mix.thud) {                                            // a recorded thud for the apples, started at its first audible sample
  const x = mono(readWav(mix.thud.file)), pk = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0), i0 = x.findIndex((v) => Math.abs(v) > 0.02 * pk), cut = x.slice(i0).map((v) => v / pk);
  SOUND.apple = (v) => [cut, 0.3 * Math.min(1, v / 4)];
}
for (const s of mix.songs ?? []) place(faded(mono(readWav(s.file)).slice(Math.round(s.from * SR), Math.round(s.to * SR))), s.at, s.pan ?? 0, dB(s.gain ?? 0));
const cues = [];
for (const h of ev.hits) {
  if (h.t < 0 || h.t >= ev.frames / ev.fps) continue;
  cues.push({ t: +h.t.toFixed(4), kind: h.kind, id: h.id });
  const make = SOUND[h.kind];
  if (!make) continue;                                    // an event with no honest synthetic sound (the robin drinking) is a cue only
  const [x, gain] = make(h.v ?? 0);
  place(x, h.t, h.pan, (gain * 3) / Math.max(h.dist, 1));  // levels are set for 3 m
}

// ---- 16-bit stereo WAV
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
if (peak > 0.98) throw new Error(`peak ${peak.toFixed(2)}: turn the gains down, clipping is not a mix decision`);
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * 32767), 46 + i * 4); }
writeFileSync(outPath, buf);
writeFileSync(outPath.replace(/\.wav$/, "") + ".cues.json", JSON.stringify(cues, null, 1));
console.log(`${outPath}: ${N} samples = ${(N / SR).toFixed(3)} s at ${SR} Hz (${ev.frames} frames at ${ev.fps} fps), peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS, rms ${(20 * Math.log10(rms(L))).toFixed(1)} dBFS, ${cues.length} cues`);
