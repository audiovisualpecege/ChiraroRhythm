/**
 * As sobreposições do gabarito que as impressões digitais NÃO confirmaram:
 * são sincronias reais (GCC-PHAT acha pico no deslocamento do gabarito) ou
 * órfãos encostados por acaso?
 *   node dev/sync-unconf.js <gabarito.json> <cacheDir>
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
  const f = { env, envMs: A.ENV_MS, hopSec: A.HOP_SEC, waveSr: A.WAVE_SR, wave: new Int8Array(ab, o, nw), lm: { hash, t } };
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
gab.tracks.forEach((t, ti) => t.clips.forEach((c) => items.push({ ...c, track: ti, tid: t.id })));
const opt = Object.assign({}, M.DEFAULTS, { gccMinSharp: 0 });
const hist = { "sharp<4": 0, "4-6": 0, "6-8": 0, "8-12": 0, "12+": 0 };
const rows = [];
let n = 0;
for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
  const a = items[i], b = items[j];
  if (a.track === b.track) continue;
  const as = a.syncedStart, ae = as + a.end - a.start, bs = b.syncedStart, be = bs + b.end - b.start;
  const ov = Math.min(ae, be) - Math.max(as, bs);
  if (ov < 1) continue;
  const D = (bs - b.inPoint) - (as - a.inPoint);
  const fa = feat(a.path), fb = feat(b.path);
  const v = votesAt(fa, fb, D);
  if (v >= 6) continue;
  n++;
  const g = M.gccRefine(fa, fb, D, opt);
  const s = g ? g.sharp : 0;
  const k = s < 4 ? "sharp<4" : s < 6 ? "4-6" : s < 8 ? "6-8" : s < 12 ? "8-12" : "12+";
  hist[k]++;
  if (rows.length < 25 && s >= 6) rows.push({ par: `${a.tid}:${a.name}~${b.tid}:${b.name}`, sobrep: ov.toFixed(1), votos: v, sharp: s.toFixed(1), ajusteMs: g && g.ok ? ((g.offset - D) * 1000).toFixed(0) : "-" });
}
console.log(`sobreposições sem confirmação das impressões: ${n}`);
console.log("nitidez do GCC-PHAT no deslocamento do gabarito:", hist);
console.table(rows);
