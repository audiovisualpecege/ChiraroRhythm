/**
 * Calibra a nitidez (z) do GCC-PHAT: pares reais (gabarito confirmado pelas
 * impressões) × pares aleatórios (clipes de faixas diferentes, deslocamento
 * qualquer com sobreposição).
 *   node dev/sync-calib.js <gabarito.json> <cacheDir>
 */
const fs = require("fs");
const path = require("path");
const M = require("../extension/js/sync/syncMatch.js");
const A = require("../extension/js/sync/syncAudio.js");

const [gabFile, cacheDir] = process.argv.slice(2);
const gab = JSON.parse(fs.readFileSync(gabFile, "utf8"));
const keyOf = (p) => p.replace(/[^A-Za-z0-9]+/g, "_").slice(-120);
const cache = new Map();
function feat(p) {
  if (cache.has(p)) return cache.get(p);
  const b = fs.readFileSync(path.join(cacheDir, keyOf(p) + ".feat"));
  const ne = b.readUInt32LE(0), nl = b.readUInt32LE(4), nw = b.readUInt32LE(12);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  let o = 16;
  const env = new Float32Array(ab, o, ne); o += ne * 4;
  const hash = new Uint32Array(ab, o, nl); o += nl * 4;
  const t = new Uint32Array(ab, o, nl); o += nl * 4;
  const f = { env, envMs: A.ENV_MS, hopSec: A.HOP_SEC, waveSr: A.WAVE_SR, wave: new Int8Array(ab, o, nw), lm: { hash, t }, dur: ne * A.ENV_MS / 1000 };
  cache.set(p, f);
  return f;
}
function votesAt(fa, fb, D) {
  const idx = new Map();
  for (let i = 0; i < fb.lm.hash.length; i++) { const h = fb.lm.hash[i]; if (!idx.has(h)) idx.set(h, []); idx.get(h).push(fb.lm.t[i]); }
  const off = Math.round(D / fa.hopSec);
  let c = 0;
  for (let i = 0; i < fa.lm.hash.length; i++) { const l = idx.get(fa.lm.hash[i]); if (l) for (const tb of l) if (Math.abs(fa.lm.t[i] - tb - off) <= 1) c++; }
  return c;
}
const items = [];
gab.tracks.forEach((t, ti) => t.clips.forEach((c) => items.push({ ...c, track: ti })));
const o0 = Object.assign({}, M.DEFAULTS, { gccMinSharp: -1e9 });
const real = [], realShort = [];
for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
  const a = items[i], b = items[j];
  if (a.track === b.track) continue;
  const as = a.syncedStart, ae = as + a.end - a.start, bs = b.syncedStart, be = bs + b.end - b.start;
  const ov = Math.min(ae, be) - Math.max(as, bs);
  if (ov < 1) continue;
  const D = (bs - b.inPoint) - (as - a.inPoint);
  const fa = feat(a.path), fb = feat(b.path);
  if (votesAt(fa, fb, D) < 6) continue;
  // desloca 40 ms para simular o erro do deslocamento grosso
  const g = M.gccRefine(fa, fb, D + 0.04, o0, 3);
  if (g) (ov < 10 ? realShort : real).push(g.sharp);
}
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const fake = [];
while (fake.length < 600) {
  const a = items[Math.floor(rnd() * items.length)], b = items[Math.floor(rnd() * items.length)];
  if (a.track === b.track) continue;
  const fa = feat(a.path), fb = feat(b.path);
  // deslocamento aleatório com sobreposição
  const D = -fb.dur + rnd() * (fa.dur + fb.dur);
  const g = M.gccRefine(fa, fb, D, o0, 3);
  if (g && g.sharp != null) fake.push(g.sharp);
}
const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const show = (nm, arr) => console.log(`${nm} (n=${arr.length}): p5 ${q(arr, 0.05)} · p10 ${q(arr, 0.1)} · p25 ${q(arr, 0.25)} · mediana ${q(arr, 0.5)} · p90 ${q(arr, 0.9)} · p99 ${q(arr, 0.99)} · máx ${q(arr, 1)}`);
show("reais (sobreposição ≥ 10 s)", real);
show("reais curtos (< 10 s)", realShort);
show("aleatórios", fake);
for (const th of [5, 6, 7, 8, 9, 10]) {
  const fr = (arr) => ((100 * arr.filter((x) => x >= th).length) / arr.length).toFixed(1);
  console.log(`limiar ${th}: reais ${fr(real)}% · curtos ${fr(realShort)}% · aleatórios (falso positivo) ${fr(fake)}%`);
}
