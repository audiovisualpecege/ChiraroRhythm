/**
 * Arbitragem de precisão: GCC-PHAT na forma de onda (16 kHz) entre duas
 * mídias, ao redor de um deslocamento. Mostra o pico e compara com outros.
 *   node dev/sync-gcc.js <mídiaA> <mídiaB> <D_s> [D_alternativo...]
 * D = tempo 0 da mídia B em relação ao tempo 0 da mídia A.
 */
const C = require("../extension/js/audio/containers.js");

const SR = 16000;

function readMono(file, fromSec, durSec) {
  const { src, info } = C.openMedia(file);
  try {
    const sr = info.sampleRate, ch = info.channels, fb = info.frameBytes, bps = info.bytesPerSample;
    const f0 = Math.max(0, Math.floor(fromSec * sr)), f1 = Math.floor((fromSec + durSec) * sr);
    const out = new Float64Array(Math.ceil(((f1 - f0) * SR) / sr) + 2);
    let acc = 0, n = 0, pos = 0, next = 1, k = 0;
    const ratio = SR / sr;
    for (const chunk of info.chunks) {
      const cs = chunk.firstFrame, ce = cs + chunk.frames;
      if (ce <= f0 || cs >= f1) continue;
      const a = Math.max(cs, f0), b = Math.min(ce, f1);
      const buf = src.read(chunk.offset + (a - cs) * fb, (b - a) * fb);
      for (let i = 0; i < b - a; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += info.read(buf, i * fb + c * bps);
        acc += s / ch; n++;
        pos += ratio;
        if (pos >= next) { if (k < out.length) out[k++] = acc / n; acc = 0; n = 0; next++; }
      }
    }
    return out.subarray(0, k);
  } finally { src.close(); }
}

function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const [fa, fb, Ds, ...alts] = process.argv.slice(2);
const D = +Ds;
const { info: ia } = C.openMedia(fa); const { info: ib } = C.openMedia(fb);
// trecho comum (tempo de A), até 20 s no meio
const from = Math.max(0, D), to = Math.min(ia.durationSec, D + ib.durationSec);
const len = Math.min(20, to - from - 0.5);
const mid = (from + to) / 2;
const t0 = mid - len / 2;
const MARGIN = 0.3;
const xa = readMono(fa, t0, len);
const xb = readMono(fb, t0 - D - MARGIN, len + 2 * MARGIN);
let N = 1; while (N < xa.length + xb.length) N <<= 1;
const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
ar.set(xa); br.set(xb);
fft(ar, ai, false); fft(br, bi, false);
// R = B · conj(A) / |...|  -> pico em lag L: xb[n + L] ≈ xa[n]
const rr = new Float64Array(N), ri = new Float64Array(N);
for (let k = 0; k < N; k++) {
  const re = br[k] * ar[k] + bi[k] * ai[k];
  const im = bi[k] * ar[k] - br[k] * ai[k];
  const m = Math.hypot(re, im) || 1;
  rr[k] = re / m; ri[k] = im / m;
}
fft(rr, ri, true);
// lag L em amostras: xa[n] corresponde a xb[n + L]; L esperado = MARGIN*SR (se D estiver certo)
let best = -Infinity, bestL = 0;
const maxL = Math.round(2 * MARGIN * SR);
for (let L = 0; L <= maxL; L++) { const v = rr[L]; if (v > best) { best = v; bestL = L; } }
let mean = 0; for (let L = 0; L <= maxL; L++) mean += Math.abs(rr[L]); mean /= maxL + 1;
// deslocamento real: xb começa em (t0 − D − MARGIN) de B; xa[n] (A em t0+n) = B em (t0 − D − MARGIN + (n+L)/SR)
// => tempo de B = tempo de A − D_real  =>  D_real = D + MARGIN − L/SR
const Dreal = D + MARGIN - bestL / SR;
console.log(`trecho ${len.toFixed(1)} s · pico GCC-PHAT ${(best / mean).toFixed(1)}× a média · D medido ${Dreal.toFixed(4)} s`);
for (const x of [D, ...alts.map(Number)]) console.log(`  D ${x.toFixed(4)}  →  diferença do medido: ${((x - Dreal) * 1000).toFixed(1)} ms`);
