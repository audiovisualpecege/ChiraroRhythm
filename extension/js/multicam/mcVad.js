/**
 * mcVad.js — quem está falando, um microfone por pessoa.
 *
 * Entrada: o nível (dB) de cada microfone a cada 20 ms, alinhado na timeline.
 * Cada microfone é comparado com a PRÓPRIA voz (p99) e o próprio ruído (p10) —
 * os ganhos variam muito (no podcast de teste, 16 dB entre o MIC1 e o MIC4). O
 * vazamento (a voz de uma pessoa entrando baixinho no microfone da outra) é
 * medido nos trechos em que só uma pessoa fala; um microfone só conta como fala
 * própria se estiver acima do que o vazamento de quem está mais alto explicaria.
 * Medido no podcast (39 min, 4 microfones): 0,2 s; da voz forte do mix, só 1,5%
 * fica sem microfone ativo (trechos ≤ 0,4 s).
 */
(function (root, factory) {
  const api = factory();
  root.AEMcVad = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const HOP = 0.02; // s por valor

  function pct(a, p) {
    const s = Float32Array.from(a).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  }

  /** máximo numa janela centrada de w valores (segura consoantes e microquedas) */
  function smoothMax(a, w) {
    const out = new Float32Array(a.length), h = w >> 1;
    for (let i = 0; i < a.length; i++) {
      let m = -1e9;
      for (let k = Math.max(0, i - h); k <= Math.min(a.length - 1, i + h); k++) if (a[k] > m) m = a[k];
      out[i] = m;
    }
    return out;
  }

  /**
   * @param {Float32Array[]} mics  dB a cada 20 ms, mesmo comprimento; valores muito baixos (-120) = sem áudio
   * @returns {{ segs: number[][][], noise: number[], ref: number[], leak: number[][] }}
   *   segs[pessoa] = [[início, fim], …] em segundos a partir do 1º valor
   */
  function analyze(mics, opt) {
    const o = Object.assign({ smooth: 5, onDb: 14, leakMargin: 6, minSpeech: 0.25, mergeGap: 0.3 }, opt || {});
    const n = mics.length, N = n ? mics[0].length : 0;
    const S = mics.map((m) => smoothMax(m, o.smooth));
    // referências só com o que tem áudio (buracos da timeline ficam em -120)
    const valid = (m) => { const v = []; for (let k = 0; k < m.length; k++) if (m[k] > -110) v.push(m[k]); return v.length ? v : [-120]; };
    const noise = S.map((m) => pct(valid(m), 0.1));
    const ref = S.map((m) => pct(valid(m), 0.99));
    const L = S.map((m, i) => m.map((v) => v - ref[i]));
    const leak = [...Array(n)].map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const solo = [];
      for (let k = 0; k < N; k++) {
        if (S[j][k] < noise[j] + 20) continue;
        let ok = true;
        for (let i = 0; i < n; i++) if (i !== j && S[i][k] > noise[i] + 20 && L[i][k] > L[j][k] - 8) ok = false;
        if (ok) solo.push(k);
      }
      for (let i = 0; i < n; i++) {
        if (i === j) continue;
        leak[j][i] = solo.length ? pct(solo.map((k) => L[j][k] - L[i][k]), 0.5) : 20;
      }
    }
    const act = mics.map(() => new Uint8Array(N));
    for (let k = 0; k < N; k++) {
      for (let i = 0; i < n; i++) {
        if (S[i][k] < noise[i] + o.onDb) continue;
        let own = true;
        for (let j = 0; j < n; j++) {
          if (j === i || S[j][k] < noise[j] + o.onDb) continue;
          if (L[i][k] < L[j][k] - leak[j][i] + o.leakMargin) own = false;
        }
        if (own) act[i][k] = 1;
      }
    }
    const segs = act.map((a) => {
      const raw = [];
      let s = -1;
      for (let k = 0; k <= N; k++) {
        const on = k < N && a[k];
        if (on && s < 0) s = k;
        if (!on && s >= 0) { raw.push([s * HOP, k * HOP]); s = -1; }
      }
      const merged = [];
      for (const g of raw) {
        const last = merged[merged.length - 1];
        if (last && g[0] - last[1] < o.mergeGap) last[1] = g[1];
        else merged.push(g.slice());
      }
      return merged.filter((g) => g[1] - g[0] >= o.minSpeech);
    });
    return { segs, noise, ref, leak };
  }

  /** dB a cada 20 ms a partir de um envelope de 1 ms (média dos quadrados) */
  function dbEvery20(ms) {
    const n = Math.floor(ms.length / 20), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < 20; k++) s += ms[i * 20 + k];
      const m = s / 20;
      out[i] = m > 1e-12 ? 10 * Math.log10(m) : -120;
    }
    return out;
  }

  return { HOP, analyze, dbEvery20, pct };
});
