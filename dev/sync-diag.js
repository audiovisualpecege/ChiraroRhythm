/**
 * Diagnóstico: para os pares que o gabarito sobrepõe, quantos votos e qual
 * correlação o deslocamento "verdadeiro" recebe.
 *   node dev/sync-diag.js <gabarito.json> <cacheDir>
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
  const ne = b.readUInt32LE(0), nl = b.readUInt32LE(4);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  let o = 16;
  const env = new Float32Array(ab, o, ne); o += ne * 4;
  const hash = new Uint32Array(ab, o, nl); o += nl * 4;
  const t = new Uint32Array(ab, o, nl); o += nl * 4;
  const wave = new Int8Array(ab, o, b.readUInt32LE(12));
  const f = { env, envMs: A.ENV_MS, hopSec: A.HOP_SEC, waveSr: A.WAVE_SR, wave, lm: { hash, t } };
  cache.set(p, f);
  return f;
}
function votesAt(fa, fb, offFrames) {
  // votos por deslocamento (tA − tB) entre duas fontes
  const idx = new Map();
  for (let i = 0; i < fb.lm.hash.length; i++) {
    const h = fb.lm.hash[i];
    if (!idx.has(h)) idx.set(h, []);
    idx.get(h).push(fb.lm.t[i]);
  }
  const hist = new Map();
  for (let i = 0; i < fa.lm.hash.length; i++) {
    const l = idx.get(fa.lm.hash[i]);
    if (!l) continue;
    for (const tb of l) {
      const d = fa.lm.t[i] - tb;
      hist.set(d, (hist.get(d) || 0) + 1);
    }
  }
  const at = (d) => (hist.get(d - 1) || 0) + (hist.get(d) || 0) + (hist.get(d + 1) || 0);
  let best = 0, bestD = null;
  for (const [d] of hist) { const c = at(d); if (c > best) { best = c; bestD = d; } }
  return { atTrue: at(offFrames), best, bestD };
}

const items = [];
gab.tracks.forEach((t, ti) => t.clips.forEach((c) => items.push({ ...c, track: ti, tid: t.id })));
const pairs = [];
for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
  const a = items[i], b = items[j];
  if (a.track === b.track) continue;
  const as = a.syncedStart, ae = as + a.end - a.start, bs = b.syncedStart, be = bs + b.end - b.start;
  const ov = Math.min(ae, be) - Math.max(as, bs);
  if (ov < 1) continue;
  pairs.push({ a, b, ov, D: (bs - b.inPoint) - (as - a.inPoint) });
}
const sample = process.argv[4] ? +process.argv[4] : 60;
const step = Math.max(1, Math.floor(pairs.length / sample));
const rows = [];
for (let k = 0; k < pairs.length; k += step) {
  const { a, b, ov, D } = pairs[k];
  const fa = feat(a.path), fb = feat(b.path);
  const v = votesAt(fa, fb, Math.round(D / A.HOP_SEC));
  const r = M.refine(fa, fb, D, Object.assign({}, M.DEFAULTS, { minCorr: -1 }));
  rows.push({ pair: `${a.tid}:${a.name}~${b.tid}:${b.name}`, ov: ov.toFixed(0), votosNoCerto: v.atTrue, melhor: v.best, melhorEhCerto: Math.abs(v.bestD * A.HOP_SEC - D) < 0.1, corr: r ? r.corr.toFixed(2) : "-", ajusteMs: r ? ((r.offset - D) * 1000).toFixed(0) : "-" });
}
console.table(rows);
