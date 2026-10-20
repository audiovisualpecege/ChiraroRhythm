/**
 * syncMatch.js
 *
 * Acha quais arquivos gravaram o mesmo som e com qual deslocamento.
 *
 * 1. Índice invertido das impressões digitais (hash -> [fonte, tempo]).
 * 2. Para cada hash presente em fontes de FAIXAS DIFERENTES, cada par vota
 *    no deslocamento (tempoA − tempoB). Um casamento real acumula dezenas de
 *    votos no mesmo deslocamento; coincidências se espalham.
 * 3. Os candidatos fortes passam por um ajuste fino: correlação do envelope
 *    de energia (2 ms) numa janela de ±60 ms ao redor do deslocamento grosso.
 *    Em sobreposições longas o ajuste é feito em várias janelas, o que também
 *    mede a deriva de relógio.
 *
 * "Fonte" = um arquivo de mídia numa faixa (pedaços do mesmo arquivo na
 * mesma faixa são uma fonte só). Deslocamento D (s): o tempo 0 da mídia B
 * fica D segundos depois do tempo 0 da mídia A.
 *
 * Lógica pura (sem Premiere, sem disco): testável em Node.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncMatch = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULTS = {
    maxBucket: 2000, // só hashes absurdamente comuns (zumbido contínuo) deixam de votar
    minVotes: 6,
    minRatio: 1.5, // votos do melhor deslocamento / do 2º melhor (mesmo par)
    refineMs: 60,
    minCorr: 0.25,
    floorDb: -70,
    driftWindowSec: 60,
    gccWindowSec: 3.8, // 2·(W + margem) a 4 kHz cabe numa FFT de 32768
    gccMarginSec: 0.12,
    // nitidez = z-score do pico da correlação somada (calibrado no gabarito:
    // alinhamentos aleatórios chegam no máx. a ~4,9; p99 4,3)
    gccMinSharp: 6,
    gccMinSharpPos: 4.5, // pico mínimo para usar o GCC na POSIÇÃO de um casamento já provado
    strongVotes: 30, // evidência forte só pelas impressões
    strongRatio: 3,
    gccMinSharpContext: 5.5, // pendente plausível pelo contexto: pico exigido
    gccMinSharpContextNoRatio: 6.5,
    gccMinSharpReview: 4.0, // escolhido pela cadeia de ordem: pico mínimo para aceitar como "revisar"…
    reviewMinRatio: 2, // …e só se o melhor deslocamento das impressões for ≥ 2× o 2º
  };

  const OFF_BIAS = 1 << 21; // deslocamento em quadros de hop cabe em ±2^21 (~18 h)

  // Pausa curta para a interface. setTimeout(0) custa ~15 ms no CEP 12 (68/s, medido
  // 07/10) e o Chromium pode frear timers de painel em segundo plano; MessageChannel
  // não sofre nenhum dos dois (~90 mil/s). Em Node (testes, workers): setImmediate.
  const yieldToUi = (() => {
    if (typeof window !== "undefined" && typeof MessageChannel === "function") {
      const ch = new MessageChannel();
      const waiting = [];
      ch.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
      return () => new Promise((r) => { waiting.push(r); ch.port2.postMessage(0); });
    }
    if (typeof setImmediate === "function") return () => new Promise((r) => setImmediate(r));
    return () => new Promise((r) => setTimeout(r, 0));
  })();

  /** Devolve o controle à interface de vez em quando (painel não congela) e checa o Cancelar. */
  function makeYielder(o) {
    let last = Date.now();
    return async (frac) => {
      if (Date.now() - last < 40) return;
      if (o.onProgress && frac != null) o.onProgress(frac);
      await yieldToUi();
      last = Date.now();
      if (o.isCancelled && o.isCancelled()) throw new Error("cancelado");
    };
  }

  /**
   * @param sources [{ id, track, feat }] — feat = saída de syncAudio.analyzeFile
   * @param opts + onProgress(frac 0..1), isCancelled()
   * @returns Promise<{ matches, pending, stats }>
   */
  async function matchSources(sources, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const log = o.log || (() => {});
    const hop = sources.length ? sources[0].feat.hopSec : 0.032;
    const tStart = Date.now();
    const tick = makeYielder(o);

    // ---------------------------------------------------------- 1. índice
    const index = buildIndex(sources);
    const total = index.total;

    // ---------------------------------------------------------- 2. votação
    // em faixas de fontes; com workers (o.voter), cada faixa vai para um núcleo
    let candidates = [];
    let pairsWithVotes = 0;
    const params = { maxBucket: o.maxBucket, minVotes: o.minVotes, hop };
    if (o.voter) {
      const res = await o.voter(index, params);
      for (const r of res) { candidates.push(...r.candidates); pairsWithVotes += r.pairsWithVotes; }
    } else {
      const STEP = 25;
      for (let sa = 0; sa < sources.length; sa += STEP) {
        await tick((0.6 * sa) / sources.length);
        const r = voteRange(index, sa, Math.min(sources.length, sa + STEP), params);
        candidates.push(...r.candidates);
        pairsWithVotes += r.pairsWithVotes;
      }
    }
    candidates.sort((x, y) => x.a - y.a || x.b - y.b); // mesma ordem com ou sem workers
    log(`impressões: ${total} · pares com votos: ${pairsWithVotes} · candidatos: ${candidates.length} · votação ${((Date.now() - tStart) / 1000).toFixed(1)} s`);

    // ---------------------------------------------------------- 3. fortes
    // Evidência forte só pelas impressões (muitos votos, bem acima do 2º
    // deslocamento): casou. O GCC-PHAT só decide ONDE, com precisão.
    // O resto vira "pendente": o plano filtra pelo contexto (ordem das faixas
    // em relação aos grupos fortes) e só os plausíveis passam pelo GCC.
    const matches = [];
    const pending = [];
    const strong = [];
    for (const c of candidates) {
      const ratio = c.second ? c.votes / c.second : Infinity;
      if (!(c.votes >= o.strongVotes && ratio >= o.strongRatio)) {
        c.status = "pendente";
        pending.push({ a: sources[c.a].id, b: sources[c.b].id, votes: c.votes, second: c.second, ratio, offsets: c.offsets, _c: c });
      } else strong.push(c);
    }
    // posição precisa dos fortes: todas as janelas de GCC de uma vez (workers, se houver)
    const located = await locateMany(strong.map((c) => ({ fa: sources[c.a].feat, fb: sources[c.b].feat, coarse: c.coarse })), o, o.runner);
    strong.forEach((c, k) => {
      const m = located[k];
      c.status = "ok";
      matches.push(Object.assign(m, { a: sources[c.a].id, b: sources[c.b].id, votes: c.votes, second: c.second, quality: c.votes * m.conf }));
    });
    if (o.onProgress) o.onProgress(1);
    log(`fortes: ${matches.length} · pendentes: ${pending.length} · ${((Date.now() - tStart) / 1000).toFixed(1)} s`);
    // depuração: os próprios objetos (o status muda depois, na verificação dos pendentes)
    if (o.debug) o.debug.candidates = candidates.map((c) => Object.assign(c, { aId: sources[c.a].id, bId: sources[c.b].id }));
    return { matches, pending, stats: { landmarks: total, candidates: candidates.length } };
  }

  /**
   * Índice invertido por ordenação de contagem (hash -> posições). Tudo em
   * arrays tipados (pode ir para um worker). Inclui as impressões de cada
   * fonte concatenadas (allHash/allT, de srcStart[s] a srcStart[s+1]).
   */
  function buildIndex(sources) {
    const HASHES = 1 << 21;
    let total = 0;
    for (const s of sources) total += s.feat.lm.hash.length;
    const bucketStart = new Uint32Array(HASHES + 1);
    for (const s of sources) for (const h of s.feat.lm.hash) bucketStart[h + 1]++;
    for (let h = 0; h < HASHES; h++) bucketStart[h + 1] += bucketStart[h];
    const fill = bucketStart.slice(0, HASHES);
    const srcOf = new Uint32Array(total);
    const timeOf = new Uint32Array(total);
    const allHash = new Uint32Array(total);
    const allT = new Uint32Array(total);
    const srcStart = new Uint32Array(sources.length + 1);
    // faixa de cada fonte como número (para comparar rápido)
    const trackIds = new Map();
    const srcTrack = new Int32Array(sources.length);
    let o = 0;
    sources.forEach((s, si) => {
      if (!trackIds.has(s.track)) trackIds.set(s.track, trackIds.size);
      srcTrack[si] = trackIds.get(s.track);
      const { hash, t } = s.feat.lm;
      srcStart[si] = o;
      allHash.set(hash, o);
      allT.set(t, o);
      o += hash.length;
      for (let i = 0; i < hash.length; i++) {
        const p = fill[hash[i]]++;
        srcOf[p] = si;
        timeOf[p] = t[i];
      }
    });
    srcStart[sources.length] = o;
    return { total, bucketStart, srcOf, timeOf, allHash, allT, srcStart, srcTrack, nSources: sources.length };
  }

  /**
   * Votação das fontes [from, to): votos só contra fontes de índice maior e de
   * outra faixa; a contagem é local e vira candidato ao fim de cada fonte.
   * Pura — roda igual no painel e num worker.
   */
  function voteRange(index, from, to, params) {
    const { bucketStart, srcOf, timeOf, allHash, allT, srcStart, srcTrack } = index;
    const { maxBucket, minVotes, hop } = params;
    const candidates = [];
    let pairsWithVotes = 0;
    for (let sa = from; sa < to; sa++) {
      const trackA = srcTrack[sa];
      const local = new Map(); // sb * 2^22 + (off + bias) -> votos
      for (let i = srcStart[sa]; i < srcStart[sa + 1]; i++) {
        const h = allHash[i];
        const b0 = bucketStart[h], b1 = bucketStart[h + 1];
        if (b1 - b0 > maxBucket) continue;
        const ta = allT[i];
        for (let q = b0; q < b1; q++) {
          const sb = srcOf[q];
          if (sb <= sa || srcTrack[sb] === trackA) continue;
          const key = sb * 4194304 + (ta - timeOf[q] + OFF_BIAS);
          local.set(key, (local.get(key) || 0) + 1);
        }
      }
      // por fonte b: melhores deslocamentos (somando ±1 hop)
      const perB = new Map();
      for (const [key, c] of local) {
        const sb = Math.floor(key / 4194304);
        let m = perB.get(sb);
        if (!m) perB.set(sb, (m = new Map()));
        m.set((key % 4194304) - OFF_BIAS, c);
      }
      for (const [sb, m] of perB) {
        pairsWithVotes++;
        const scored = [];
        for (const [off, c0] of m) {
          if (c0 < 2) continue;
          scored.push([off, (m.get(off - 1) || 0) + c0 + (m.get(off + 1) || 0)]);
        }
        if (!scored.length) continue;
        scored.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
        if (scored[0][1] < minVotes) continue;
        const tops = [];
        for (const s of scored) {
          if (tops.every((t) => Math.abs(t[0] - s[0]) > 3)) tops.push(s);
          if (tops.length === 4) break;
        }
        candidates.push({
          a: sa, b: sb, coarse: tops[0][0] * hop, votes: tops[0][1], second: tops[1] ? tops[1][1] : 0,
          offsets: tops.slice(0, 3).filter((t) => t[1] >= minVotes).map((t) => ({ off: t[0] * hop, votes: t[1] })),
        });
      }
    }
    return { candidates, pairsWithVotes };
  }

  /**
   * Posição precisa de casamentos já aceitos: GCC-PHAT (até 3 janelas somadas,
   * pico com fração de amostra) se houver pico; senão o envelope.
   * reqs = [{ fa, fb, coarse }]
   */
  async function locateMany(reqs, o, runner) {
    const oLoose = Object.assign({}, o, { gccMinSharp: o.gccMinSharpPos });
    const gs = await gccMany(reqs.map((r) => ({ fa: r.fa, fb: r.fb, D: r.coarse, o: oLoose })), runner);
    return reqs.map(({ fa, fb, coarse }, k) => {
      const g = gs[k];
      if (g && g.ok) return { offset: g.offset, sharp: g.sharp, precise: true, driftSec: g.driftSec, conf: Math.min(1, g.sharp / 12) };
      const r = refine(fa, fb, coarse, Object.assign({}, o, { minCorr: -1 }));
      return { offset: r ? r.offset : coarse, sharp: g ? g.sharp : 0, precise: false, corr: r ? r.corr : 0, driftSec: r ? r.driftSec : 0, conf: 0.3 * Math.max(0.1, r ? r.corr : 0.1) };
    });
  }

  /**
   * Verifica um pendente (já considerado plausível pelo contexto): testa os
   * melhores deslocamentos das impressões no GCC-PHAT. Devolve o casamento
   * (marcado weak) ou null.
   */
  /**
   * lenient (par escolhido pela cadeia de ordem): além da confirmação forte,
   * aceita como "revisar" quem tem pico fraco no GCC ou só boas impressões.
   */
  function verifyPending(fa, fb, p, opts, lenient) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const gs = (p.offsets || []).map((x) => gccRefine(fa, fb, x.off, Object.assign({}, o, { gccMinSharp: -1e9 })));
    return decidePending(p, gs, o, lenient);
  }

  /** Decide um pendente a partir do GCC medido em cada deslocamento candidato (gs[i] ↔ p.offsets[i]). */
  function decidePending(p, gs, o, lenient) {
    const need = p.ratio >= o.minRatio ? o.gccMinSharpContext : o.gccMinSharpContextNoRatio;
    let best = null;
    (p.offsets || []).forEach((x, i) => {
      const g = gs[i];
      if (g && (!best || g.sharp > best.g.sharp)) best = { g, x };
    });
    const mk = (offset, sharp, precise, review, votes, driftSec) => ({
      a: p.a, b: p.b, offset, votes, second: p.second, sharp, precise, weak: true, review, driftSec,
      quality: 0.01 * votes * (precise ? Math.min(1, sharp / 12) : 0.2),
    });
    const g = best && best.g;
    if (g && g.sharp >= need) return mk(g.offset, g.sharp, true, false, best.x.votes, g.driftSec);
    if (!lenient) return null;
    // "revisar": pico fraco no GCC só vale com o melhor deslocamento das impressões
    // bem destacado (razão ≥ 2). Medido no gabarito: razão < 2 com pico fraco é
    // quase sempre coincidência, e "só impressões" sem pico também.
    if (g && g.sharp >= o.gccMinSharpReview && p.ratio >= o.reviewMinRatio) return mk(g.offset, g.sharp, true, true, best.x.votes, g.driftSec);
    return null;
  }

  /**
   * Correlação do envelope (dB) de A com B deslocado em D ± refineMs.
   * Retorna { offset, corr, overlapSec, driftSec } ou null.
   */
  function refine(fa, fb, D, o) {
    const step = fa.envMs / 1000;
    const ea = fa.env, eb = fb.env;
    const durA = ea.length * step, durB = eb.length * step;
    const from = Math.max(0, D);
    const to = Math.min(durA, D + durB);
    const overlap = to - from;
    if (overlap < 1) return null;
    const lagN = Math.round(o.refineMs / fa.envMs);

    // janelas: a sobreposição inteira se curta; senão várias janelas espalhadas
    const W = o.driftWindowSec;
    const windows = [];
    if (overlap <= 3 * W) windows.push([from, to]);
    else {
      const n = Math.min(9, Math.max(3, Math.floor(overlap / (W * 4))));
      for (let k = 0; k < n; k++) {
        const c = from + W / 2 + ((overlap - W) * k) / (n - 1);
        windows.push([c - W / 2, c + W / 2]);
      }
    }

    const results = [];
    for (const [w0, w1] of windows) {
      const r = corrWindow(ea, eb, w0, w1, D, step, lagN, o.floorDb);
      if (r) results.push({ t: (w0 + w1) / 2, ...r });
    }
    if (!results.length) return null;
    const good = results.filter((r) => r.corr >= o.minCorr);
    if (!good.length) return null;
    // deslocamento: mediana das janelas boas (= alinhar pelo meio quando há deriva)
    const offs = good.map((r) => r.offset).sort((x, y) => x - y);
    const offset = offs[Math.floor(offs.length / 2)];
    const corr = good.reduce((s, r) => s + r.corr, 0) / good.length;
    let driftSec = 0;
    if (good.length >= 2) {
      const first = good[0], last = good[good.length - 1];
      driftSec = last.offset - first.offset;
    }
    return { offset, corr, overlapSec: overlap, driftSec };
  }

  function corrWindow(ea, eb, w0, w1, D, step, lagN, floorDb) {
    // amostras de A em [w0, w1); B no tempo (t − D − lag)
    const i0 = Math.max(lagN, Math.ceil(w0 / step));
    const i1 = Math.min(ea.length - lagN, Math.floor(w1 / step));
    const shift = Math.round(D / step);
    const n = i1 - i0;
    if (n < 200) return null; // < 0,4 s
    // média de A
    let ma = 0;
    for (let i = i0; i < i1; i++) ma += Math.max(floorDb, ea[i]);
    ma /= n;
    let va = 0;
    for (let i = i0; i < i1; i++) { const x = Math.max(floorDb, ea[i]) - ma; va += x * x; }
    if (va <= 1e-9) return null;
    let best = -2, bestLag = 0;
    const cs = new Float64Array(2 * lagN + 1);
    for (let L = -lagN; L <= lagN; L++) {
      let mb = 0, cnt = 0;
      for (let i = i0; i < i1; i++) {
        const j = i - shift - L;
        if (j < 0 || j >= eb.length) continue;
        mb += Math.max(floorDb, eb[j]);
        cnt++;
      }
      if (cnt < n * 0.8) { cs[L + lagN] = -2; continue; }
      mb /= cnt;
      let sab = 0, vb = 0;
      for (let i = i0; i < i1; i++) {
        const j = i - shift - L;
        if (j < 0 || j >= eb.length) continue;
        const x = Math.max(floorDb, ea[i]) - ma;
        const y = Math.max(floorDb, eb[j]) - mb;
        sab += x * y;
        vb += y * y;
      }
      const c = vb > 1e-9 ? sab / Math.sqrt(va * vb) : -2;
      cs[L + lagN] = c;
      if (c > best) { best = c; bestLag = L; }
    }
    if (best <= -1) return null;
    // interpolação parabólica
    let frac = 0;
    const k = bestLag + lagN;
    if (k > 0 && k < cs.length - 1 && cs[k - 1] > -2 && cs[k + 1] > -2) {
      const den = cs[k - 1] - 2 * cs[k] + cs[k + 1];
      if (den < 0) frac = (0.5 * (cs[k - 1] - cs[k + 1])) / den;
    }
    return { offset: (shift + bestLag + frac) * step, corr: best };
  }

  // -------------------------------------------------------------- GCC-PHAT
  // Ajuste fino na forma de onda (4 kHz): a correlação cruzada com
  // "transformação de fase" ignora a coloração de cada microfone e dá um pico
  // estreito no atraso real — precisão de fração de milissegundo.
  const fftCache = new Map();
  function fftPlan(n) {
    let p = fftCache.get(n);
    if (p) return p;
    const rev = new Uint32Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      rev[i] = j;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    p = { rev, cos, sin };
    fftCache.set(n, p);
    return p;
  }
  function fft(re, im, inverse) {
    const n = re.length;
    const { rev, cos, sin } = fftPlan(n);
    for (let i = 1; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const wr = cos[k], wi = sgn * sin[k];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  const decode8 = (c) => { const v = c / 127; return v < 0 ? -v * v : v * v; };

  /** Recorta a janela de A (tempo de A [t0, t0+W)) e a de B ao redor de D ± M. */
  function gccSlices(fa, fb, t0, W, D, M) {
    const sr = fa.waveSr;
    const a0 = Math.round(t0 * sr), na = Math.round(W * sr);
    const b0 = Math.round((t0 - D - M) * sr), nb = Math.round((W + 2 * M) * sr);
    if (a0 < 0 || a0 + na > fa.wave.length || b0 < 0 || b0 + nb > fb.wave.length) return null;
    return { a: fa.wave.slice(a0, a0 + na), b: fb.wave.slice(b0, b0 + nb) };
  }

  /**
   * A parte pesada (FFT): correlação GCC-PHAT de duas janelas já recortadas.
   * Pura — roda igual no painel e num worker. job = { a, b, D, M, sr }.
   */
  function gccCompute(job) {
    const { a, b, D, M, sr } = job;
    const na = a.length, nb = b.length;
    let n = 1;
    while (n < na + nb) n <<= 1;
    const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    let ea = 0, eb = 0;
    for (let i = 0; i < na; i++) { const v = decode8(a[i]); ar[i] = v; ea += v * v; }
    for (let i = 0; i < nb; i++) { const v = decode8(b[i]); br[i] = v; eb += v * v; }
    if (ea < 1e-6 * na || eb < 1e-6 * nb) return null; // trecho mudo
    fft(ar, ai, false);
    fft(br, bi, false);
    for (let k = 0; k < n; k++) {
      const re = br[k] * ar[k] + bi[k] * ai[k];
      const im = bi[k] * ar[k] - br[k] * ai[k];
      const m = Math.sqrt(re * re + im * im) || 1;
      ar[k] = re / m; ai[k] = im / m;
    }
    fft(ar, ai, true);
    const maxL = Math.round(2 * M * sr);
    const r = ar.slice(0, maxL + 1);
    return { r, ...peakOf(r, D, M, sr) };
  }

  /**
   * Pico de uma correlação r[L] (L = 0..2M·sr): deslocamento e nitidez.
   * sharp = (pico − média) / desvio, sem a vizinhança do pico (z-score).
   */
  function peakOf(r, D, M, sr) {
    const n = r.length;
    let best = -Infinity, bestL = 0;
    for (let L = 0; L < n; L++) if (r[L] > best) { best = r[L]; bestL = L; }
    let s = 0, s2 = 0, k = 0;
    for (let L = 0; L < n; L++) {
      if (Math.abs(L - bestL) <= 4) continue;
      s += r[L]; s2 += r[L] * r[L]; k++;
    }
    const mean = k ? s / k : 0;
    const sd = k ? Math.sqrt(Math.max(1e-12, s2 / k - mean * mean)) : 1;
    let frac = 0;
    if (bestL > 0 && bestL < n - 1) {
      const y0 = r[bestL - 1], y1 = r[bestL], y2 = r[bestL + 1];
      const den = y0 - 2 * y1 + y2;
      if (den < 0) frac = (0.5 * (y0 - y2)) / den;
    }
    // A em (t0 + i/sr) = B em (t0 − D − M + (i + L)/sr)  =>  D_real = D + M − L/sr
    return { offset: D + M - (bestL + frac) / sr, sharp: (best - mean) / sd };
  }

  /**
   * Ajuste fino por GCC-PHAT ao redor de D (deslocamento já bom em ±M).
   * Até 3 janelas de W s espalhadas pela sobreposição (mede deriva também).
   */
  /**
   * Escolhe até `count` janelas de W s dentro de [from, to) (tempo de A) onde
   * os DOIS arquivos têm som (maior "energia mínima" pelo envelope), com
   * espaçamento mínimo entre elas — no silêncio o GCC não acha nada.
   */
  function pickWindows(fa, fb, D, from, to, W, count) {
    const step = fa.envMs / 1000;
    const hopW = Math.max(W / 2, (to - from - W) / 40);
    const cands = [];
    for (let t = from; t + W <= to + 1e-9; t += hopW) {
      let sa = 0, sb = 0, n = 0;
      const i0 = Math.floor(t / step), i1 = Math.floor((t + W) / step);
      for (let i = i0; i < i1; i += 5) {
        const j = Math.round(i - D / step);
        if (i < 0 || i >= fa.env.length || j < 0 || j >= fb.env.length) continue;
        sa += Math.pow(10, fa.env[i] / 10);
        sb += Math.pow(10, fb.env[j] / 10);
        n++;
      }
      if (!n) continue;
      const e = Math.min(10 * Math.log10(sa / n + 1e-12), 10 * Math.log10(sb / n + 1e-12));
      cands.push({ t, e });
    }
    cands.sort((x, y) => y.e - x.e);
    const out = [];
    const minGap = Math.min(W * 2, (to - from) / (count + 1));
    for (const c of cands) {
      if (out.length >= count) break;
      if (out.every((o) => Math.abs(o - c.t) >= minGap)) out.push(c.t);
    }
    return out.sort((x, y) => x - y);
  }

  /** Escolhe e recorta as janelas (barato). null = sem sobreposição útil. */
  function gccPrepare(fa, fb, D, o, count) {
    if (!fa.wave || !fb.wave) return null;
    const W0 = o.gccWindowSec, M = o.gccMarginSec;
    const durA = fa.wave.length / fa.waveSr, durB = fb.wave.length / fb.waveSr;
    const from = Math.max(0, D) + M, to = Math.min(durA, D + durB) - M;
    const overlap = to - from;
    if (overlap < 1) return null;
    const W = Math.min(W0, overlap);
    const n = count || (overlap >= 3 * W0 ? 3 : overlap >= 1.5 * W0 ? 2 : 1);
    const jobs = [];
    for (const t0 of pickWindows(fa, fb, D, from, to, W, n)) {
      const s = gccSlices(fa, fb, t0, W, D, M);
      if (s) jobs.push({ a: s.a, b: s.b, D, M, sr: fa.waveSr });
    }
    return { D, M, sr: fa.waveSr, jobs };
  }

  /** Junta os resultados das janelas de um par (soma as correlações). */
  function gccFinish(prep, results, o) {
    if (!prep) return null;
    const res = results.filter(Boolean);
    if (!res.length) return { ok: false, sharp: 0 };
    const { D, M, sr } = prep;
    // soma as correlações das janelas (o atraso real se reforça, o ruído não)
    const sum = new Float64Array(res[0].r.length);
    for (const x of res) for (let L = 0; L < sum.length; L++) sum[L] += x.r[L];
    const pk = peakOf(sum, D, M, sr);
    if (pk.sharp < o.gccMinSharp) return { ok: false, sharp: pk.sharp };
    // deriva: janelas nítidas sozinhas, perto do pico somado
    const each = res.filter((x) => x.sharp >= o.gccMinSharp && Math.abs(x.offset - pk.offset) <= 0.03);
    const driftSec = each.length >= 2 ? each[each.length - 1].offset - each[0].offset : 0;
    return { ok: true, offset: pk.offset, sharp: pk.sharp, windows: res.length, driftSec };
  }

  /** Versão direta (um par, sem paralelismo) — usada nos testes e no árbitro. */
  function gccRefine(fa, fb, D, o, count) {
    const prep = gccPrepare(fa, fb, D, o, count);
    if (!prep) return null;
    return gccFinish(prep, prep.jobs.map(gccCompute), o);
  }

  /** Executor padrão: calcula as janelas aqui mesmo (sem workers). */
  const inlineRunner = async (jobs) => jobs.map(gccCompute);

  /**
   * Vários pares de uma vez: prepara todos, manda TODAS as janelas ao executor
   * (que pode ser um pool de workers) e junta par a par.
   * reqs = [{ fa, fb, D, o, count }] → Promise<[resultado | null]>
   */
  async function gccMany(reqs, runner) {
    const preps = reqs.map((r) => gccPrepare(r.fa, r.fb, r.D, r.o, r.count));
    const flat = [];
    preps.forEach((p, i) => { if (p) p.jobs.forEach((j) => flat.push({ i, j })); });
    const out = flat.length ? await (runner || inlineRunner)(flat.map((x) => x.j)) : [];
    const per = preps.map(() => []);
    flat.forEach((x, k) => per[x.i].push(out[k]));
    return preps.map((p, i) => gccFinish(p, per[i], reqs[i].o));
  }

  /**
   * Conveniência: clipes -> fontes (track+mídia) -> casamentos entre fontes.
   * @param clips [{ id, track, media }]
   * @param feats Map(media -> feat)
   */
  async function findMatches(clips, feats, opts) {
    const srcKey = new Map();
    const sources = [];
    for (const c of clips) {
      const k = c.track + "|" + c.media;
      if (srcKey.has(k)) continue;
      const feat = feats.get(c.media);
      if (!feat) continue;
      srcKey.set(k, sources.length);
      sources.push({ id: k, track: c.track, media: c.media, feat });
    }
    const r = await matchSources(sources, opts);
    const ref = (k) => ({ track: k.slice(0, k.indexOf("|")), media: k.slice(k.indexOf("|") + 1) });
    const byId = new Map(sources.map((s) => [s.id, s]));
    const conv = (m) => ({ ...m, a: ref(m.a), b: ref(m.b) });
    const memo = new Map(); // refazer o plano (ex.: clipe mandado para órfão) não repete o GCC
    const o = Object.assign({}, DEFAULTS, opts || {});
    const oAny = Object.assign({}, o, { gccMinSharp: -1e9 });
    const keyOf = (p, lenient) => p.a.track + "|" + p.a.media + "#" + p.b.track + "|" + p.b.media + "#" + (lenient ? 1 : 0);
    return {
      matches: r.matches.map(conv),
      pending: r.pending.map(conv),
      /**
       * Para o plano: verifica VÁRIOS pendentes plausíveis de uma vez (GCC-PHAT
       * em todos os deslocamentos candidatos, em paralelo se houver workers).
       * Devolve um casamento (ou null) por pendente, na mesma ordem.
       */
      verifyMany: async (list, lenient) => {
        const todo = list.filter((p) => !memo.has(keyOf(p, lenient)));
        const reqs = [];
        const owner = [];
        todo.forEach((p, k) => {
          const fa = byId.get(p.a.track + "|" + p.a.media).feat, fb = byId.get(p.b.track + "|" + p.b.media).feat;
          for (const x of p.offsets || []) { reqs.push({ fa, fb, D: x.off, o: oAny }); owner.push(k); }
        });
        const gs = await gccMany(reqs, o.runner);
        const per = todo.map(() => []);
        gs.forEach((g, i) => per[owner[i]].push(g));
        todo.forEach((p, k) => {
          const ka = p.a.track + "|" + p.a.media, kb = p.b.track + "|" + p.b.media;
          memo.set(keyOf(p, lenient), decidePending({ ...p, a: ka, b: kb }, per[k], o, lenient));
        });
        return list.map((p) => {
          const m = memo.get(keyOf(p, lenient));
          if (p._c) p._c.status = m ? "ok" : "gcc";
          return m ? conv(m) : null;
        });
      },
      stats: r.stats,
    };
  }

  return { DEFAULTS, matchSources, findMatches, refine, gccRefine, gccCompute, gccMany, verifyPending, voteRange };
});
