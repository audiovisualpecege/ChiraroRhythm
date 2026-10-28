/**
 * mcMap.js — "Sugerir mapa" da Multicâmera: o que cada faixa é, sem a pessoa marcar.
 *
 *  - Mix × microfones (só áudio): o mix acompanha o "mais alto dos outros" o
 *    tempo todo (no podcast de teste: correlação 0,97; microfones 0,43–0,72).
 *  - Corte ao vivo (imagem): o quadro dele é igual ao de outra faixa quase
 *    sempre (podcast: 40 de 40 instantes); tirado ele, as câmeras não se repetem.
 *  - Quem aparece em cada câmera (imagem × áudio): nos trechos em que UMA
 *    pessoa fala sozinha, o rosto dela mexe a boca e os outros ficam parados.
 *    Pontuação rosto × pessoa = movimento da boca nos trechos da pessoa ÷
 *    movimento médio em todos os trechos (podcast, 2 trechos por pessoa: rostos
 *    certos com 1,7–2,9×; os outros ≤ 1,1×). Cada rosto é uma pessoa diferente.
 *    Plano aberto (rostos pequenos/de perfil) não separa bem as bocas — câmera
 *    com 3+ rostos (e pelo menos todos menos um) vira "todos".
 *
 * Lógica pura (painel e testes). A leitura de quadros/bocas fica no multicamTool.
 */
(function (root, factory) {
  const api = factory();
  root.AEMcMap = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEF = { mixCorr: 0.9, perPerson: 2, winLen: 10, minSolo: 4, maxOthers: 0.1, minScore: 1.3, wideFaces: 3 };

  function pct(a, p) {
    const s = Float32Array.from(a).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  }
  function corr(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let s = 0, sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
    return sa && sb ? s / Math.sqrt(sa * sb) : 0;
  }

  /**
   * Quais faixas de áudio são mix (dB a cada 20 ms, mesmo comprimento).
   * Cada faixa normalizada pela própria voz (p99); mix = correlação ≥ mixCorr com o máximo das outras.
   * @returns {{ mix: boolean[], corr: number[] }}
   */
  function detectMix(levels, opt) {
    const o = Object.assign({}, DEF, opt || {});
    const n = levels.length;
    if (n < 3) return { mix: new Array(n).fill(false), corr: new Array(n).fill(0) }; // com 2 faixas não dá para dizer
    const N = levels[0].length;
    const norm = levels.map((a) => { const r = pct(a, 0.99); return a.map((v) => v - r); });
    const c = norm.map((self, i) => {
      const others = new Float32Array(N);
      for (let k = 0; k < N; k++) { let m = -400; for (let j = 0; j < n; j++) if (j !== i && norm[j][k] > m) m = norm[j][k]; others[k] = m; }
      return corr(self, others);
    });
    // só a que mais se parece com as outras pode ser mix (no máximo uma, e só se se destacar)
    const best = c.indexOf(Math.max(...c));
    return { mix: c.map((v, i) => i === best && v >= o.mixCorr), corr: c };
  }

  /**
   * Trechos em que uma pessoa fala sozinha: até perPerson por pessoa, de até winLen s,
   * espalhados (o mais longo de cada parte do programa).
   * @param speech [[início, fim], …] por pessoa (s)
   */
  function pickWindows(speech, from, to, opt) {
    const o = Object.assign({}, DEF, opt || {});
    const nP = speech.length;
    const others = (p, a, b) => {
      let x = 0;
      for (let q = 0; q < nP; q++) if (q !== p) for (const [s, e] of speech[q]) x += Math.max(0, Math.min(b, e) - Math.max(a, s));
      return x / (b - a);
    };
    const out = [];
    for (let p = 0; p < nP; p++) {
      const cand = speech[p].filter(([a, b]) => b - a >= o.minSolo && a >= from && b <= to)
        .map(([a, b]) => ({ p, s: a + 0.3, e: Math.min(b, a + 0.3 + o.winLen) }))
        .filter((w) => others(w.p, w.s, w.e) < o.maxOthers);
      const parts = o.perPerson;
      for (let k = 0; k < parts; k++) {
        const a = from + ((to - from) * k) / parts, b = from + ((to - from) * (k + 1)) / parts;
        const inPart = cand.filter((w) => w.s >= a && w.s < b).sort((x, y) => (y.e - y.s) - (x.e - x.s));
        if (inPart.length) out.push(inPart[0]);
      }
      // parte sem trecho: completa com o mais longo que sobrou
      while (out.filter((w) => w.p === p).length < parts) {
        const left = cand.filter((w) => !out.includes(w)).sort((x, y) => (y.e - y.s) - (x.e - x.s));
        if (!left.length) break;
        out.push(left[0]);
      }
    }
    return out;
  }

  /**
   * Pontuação rosto × pessoa.
   * @param motion  motion[rosto][janela] = movimento médio da boca (|Δabertura| por quadro) ou null
   * @param windows [{ p }]
   * @returns score[rosto][pessoa] (null = sem dado)
   */
  function faceScores(motion, windows, nP) {
    return motion.map((row) => {
      const per = [...Array(nP)].map(() => ({ s: 0, n: 0 }));
      let all = 0, n = 0;
      row.forEach((v, wi) => { if (v == null) return; per[windows[wi].p].s += v; per[windows[wi].p].n++; all += v; n++; });
      const base = n ? all / n : 0;
      return per.map((x) => (x.n && base ? x.s / x.n / base : null));
    });
  }

  /**
   * Pessoas de uma câmera: cada rosto é uma pessoa diferente (atribuição gulosa pela maior
   * pontuação acima de minScore); 3+ rostos e pelo menos todos menos um = todos.
   * @returns {{ people: number[], wide: boolean, faces: (number|null)[] }}
   */
  function cameraPeople(score, nP, opt) {
    const o = Object.assign({}, DEF, opt || {});
    const nF = score.length;
    const faces = new Array(nF).fill(null);
    const pairs = [];
    score.forEach((row, f) => row.forEach((v, p) => { if (v != null && v >= o.minScore) pairs.push([v, f, p]); }));
    pairs.sort((a, b) => b[0] - a[0]);
    const usedP = new Set();
    for (const [, f, p] of pairs) if (faces[f] == null && !usedP.has(p)) { faces[f] = p; usedP.add(p); }
    const wide = nP >= 3 && nF >= Math.max(o.wideFaces, nP - 1); // 3+ rostos e todos menos um, no mínimo
    const people = wide ? [...Array(nP).keys()] : [...usedP].sort((a, b) => a - b);
    return { people, wide, faces };
  }

  /**
   * Corte ao vivo: faixa cujo quadro (64×36 cinza) é igual ao de outra faixa em quase todos os instantes.
   * @param frames frames[faixa][instante] = Float32Array normalizada (média 0, desvio 1) ou null
   * @returns índice da faixa ou -1
   */
  function detectProgram(frames, opt) {
    const o = Object.assign({ same: 0.15, share: 0.9 }, opt || {});
    const nT = frames.length;
    if (nT < 3) return -1;
    const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
    const rate = frames.map((fa, a) => {
      let hit = 0, n = 0;
      fa.forEach((x, k) => {
        if (!x) return;
        let best = 9;
        frames.forEach((fb, b) => { if (b !== a && fb[k]) best = Math.min(best, dist(x, fb[k])); });
        if (best < 9) { n++; if (best < o.same) hit++; }
      });
      return n ? hit / n : 0;
    });
    const top = rate.indexOf(Math.max(...rate));
    return rate[top] >= o.share ? top : -1;
  }

  /** quadro cinza w×h → normalizado (média 0, desvio 1) */
  function normalizeGray(g) {
    const f = new Float32Array(g.length);
    let s = 0, s2 = 0;
    for (let i = 0; i < g.length; i++) { f[i] = g[i]; s += g[i]; s2 += g[i] * g[i]; }
    const m = s / g.length, sd = Math.sqrt(Math.max(1e-6, s2 / g.length - m * m));
    for (let i = 0; i < g.length; i++) f[i] = (f[i] - m) / sd;
    return f;
  }

  return { DEF, detectMix, pickWindows, faceScores, cameraPeople, detectProgram, normalizeGray };
});
