/**
 * syncVisualMatch.js — a parte de cálculo da sincronização por imagem
 * ("boca × voz"), sem interface e sem ffmpeg (testável em Node).
 *
 *  - frameEnvelope: envelope de energia do áudio (syncAudio: dB a cada 2 ms)
 *    → 1 valor por quadro do vídeo (log da potência média).
 *  - xcorrNorm: correlação normalizada da abertura da boca (com buracos =
 *    quadros sem rosto) contra o envelope do gravador em TODOS os
 *    deslocamentos, por FFT (3 FFTs por par; as do gravador ficam guardadas).
 *  - speechWindows: da varredura rápida (quadros-chave), os trechos em que
 *    alguém mais mexe a boca — sem fala na janela não há sinal (medido 08/10).
 *  - decide: junta os trechos analisados (consenso de posição) e diz se o
 *    resultado é confiável (Lavanda), "revisar" (Pêssego) ou nada.
 *
 * Calibrado no banco de prova da aula (08/10): com a pessoa falando 2 min,
 * pico/2º pico 1,5–2,3 nos acertos (erro ≤ 2 quadros) e ≤ 1,17 nos erros.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncVisualMatch = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULTS = {
    hp: 15, // passa-alta: tira a média móvel de ±15 quadros dos dois sinais
    excl: 15, // o 2º pico tem que estar a mais de 15 quadros do 1º
    minRatio: 1.35, // abaixo disso a janela não conta (erros medidos ≤ 1,17)
    lavRatio: 1.8, // uma janela sozinha só vira Lavanda com pico ≥ 1,8× o 2º
    agreeFrames: 2, // janelas "concordam" se caem a até 2 quadros uma da outra
    speakOpen: 0.04, // boca "aberta" (lábios / altura do rosto) — fala
    winSec: 120,
    stepSec: 10,
    maxWindows: 4,
    minSpeech: 0.08, // fração mínima de amostras falando para a janela valer a pena
    // consenso entre janelas (podcast 15/10: pessoas de perfil, acerto com razão 1,15–1,3 descartado)
    topPeaks: 10, // picos guardados por combinação janela × pessoa × gravador
    consPeaks: 8, // posições distintas por janela que entram no consenso (as de maior z)
    consMaxChance: 0.05, // 2 janelas só contam se o nº esperado de pares por acaso for ≤ isso
  };

  /** env em dB (1 valor a cada envMs) → log10 da potência média por quadro. */
  function frameEnvelope(env, envMs, fps) {
    const per = 1000 / fps / envMs;
    const n = Math.floor(env.length / per);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * per), b = Math.max(a + 1, Math.floor((i + 1) * per));
      let p = 0;
      for (let k = a; k < b; k++) p += Math.pow(10, env[k] / 10);
      out[i] = Math.log10(p / (b - a) + 1e-12);
    }
    return out;
  }

  /** Tira a média móvel de ±k (ignora NaN; NaN continua NaN). */
  function highpass(x, k) {
    const n = x.length, out = new Float32Array(n);
    const pre = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const ok = !Number.isNaN(x[i]);
      pre[i + 1] = pre[i] + (ok ? x[i] : 0);
      cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
    }
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(x[i])) { out[i] = NaN; continue; }
      const a = Math.max(0, i - k), b = Math.min(n, i + k + 1);
      out[i] = x[i] - (pre[b] - pre[a]) / Math.max(1, cnt[b] - cnt[a]);
    }
    return out;
  }

  // ------------------------------------------------------------ FFT (radix 2, no lugar)
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (2 * Math.PI) / len * (inverse ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  /**
   * Prepara o alvo (envelope do gravador, já com passa-alta) para várias
   * correlações: guarda FFT(b) e FFT(b²) num tamanho que caiba janelas de até maxA quadros.
   */
  function prepareTarget(b, maxA) {
    const N = nextPow2(b.length + maxA);
    const br = new Float64Array(N), bi = new Float64Array(N);
    for (let i = 0; i < b.length; i++) { br[i] = b[i]; bi[i] = b[i] * b[i]; }
    // FFT de dois sinais reais de uma vez: X = FFT(b + i·b²)
    fft(br, bi, false);
    const Br = new Float64Array(N), Bi = new Float64Array(N), Qr = new Float64Array(N), Qi = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const j = (N - k) & (N - 1);
      // b: (X[k] + conj(X[N−k]))/2 · b²: (X[k] − conj(X[N−k]))/(2i)
      Br[k] = (br[k] + br[j]) / 2; Bi[k] = (bi[k] - bi[j]) / 2;
      Qr[k] = (bi[k] + bi[j]) / 2; Qi[k] = -(br[k] - br[j]) / 2;
    }
    return { N, len: b.length, Br, Bi, Qr, Qi };
  }

  /**
   * Correlação normalizada de a (NaN = ignorar) sobre o alvo preparado, para
   * todo L em [0, len − a.length]: a[0] cai no quadro L do alvo.
   */
  function xcorrNorm(a, T) {
    const n = a.length, N = T.N;
    if (T.len + n > N) throw new Error("alvo preparado pequeno demais para esta janela");
    let cnt = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) { cnt++; sum += a[i]; sum2 += a[i] * a[i]; }
    const nL = T.len - n + 1;
    if (cnt < 30 || nL < 1) return null;
    const m = sum / cnt, sd = Math.sqrt(Math.max(1e-12, sum2 / cnt - m * m));
    // Y = FFT(z + i·mask)
    const yr = new Float64Array(N), yi = new Float64Array(N);
    for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) { yr[i] = (a[i] - m) / sd; yi[i] = 1; }
    fft(yr, yi, false);
    // correlação cruzada c(L) = Σ x[i]·b[L+i] = IFFT(conj(X)·B)
    // P = conj(Z)·B + i·conj(M)·B  (dois resultados reais numa inversa) · R = conj(M)·Q
    const pr = new Float64Array(N), pi = new Float64Array(N), rr = new Float64Array(N), ri = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const j = (N - k) & (N - 1);
      const Zr = (yr[k] + yr[j]) / 2, Zi = (yi[k] - yi[j]) / 2;
      const Mr = (yi[k] + yi[j]) / 2, Mi = -(yr[k] - yr[j]) / 2;
      // conj(Z)·B
      const ar = Zr * T.Br[k] + Zi * T.Bi[k], ai = Zr * T.Bi[k] - Zi * T.Br[k];
      // conj(M)·B
      const cr = Mr * T.Br[k] + Mi * T.Bi[k], ci = Mr * T.Bi[k] - Mi * T.Br[k];
      pr[k] = ar - ci; pi[k] = ai + cr;
      rr[k] = Mr * T.Qr[k] + Mi * T.Qi[k]; ri[k] = Mr * T.Qi[k] - Mi * T.Qr[k];
    }
    fft(pr, pi, true);
    fft(rr, ri, true);
    const out = new Float32Array(nL);
    for (let L = 0; L < nL; L++) {
      const sxy = pr[L] / cnt, my = pi[L] / cnt, my2 = rr[L] / cnt;
      const v = my2 - my * my;
      out[L] = v > 1e-12 ? sxy / Math.sqrt(v) : 0;
    }
    return out;
  }

  /** Melhor pico, 2º pico (fora de ±excl) e posição com interpolação parabólica. */
  function peak(c, excl) {
    let b = 0;
    for (let i = 1; i < c.length; i++) if (c[i] > c[b]) b = i;
    let s = -1;
    for (let i = 0; i < c.length; i++) if (Math.abs(i - b) > excl && (s < 0 || c[i] > c[s])) s = i;
    let frac = 0;
    if (b > 0 && b < c.length - 1) {
      const y0 = c[b - 1], y1 = c[b], y2 = c[b + 1], den = y0 - 2 * y1 + y2;
      if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
    }
    const second = s >= 0 ? c[s] : 0;
    return { i: b + frac, v: c[b], second, ratio: c[b] / Math.max(1e-6, second) };
  }

  /**
   * Uma janela: série da boca de uma pessoa (1 valor por quadro a partir de
   * startSec do arquivo) contra um alvo preparado (envelope por quadro, já com
   * passa-alta, começando em 0 s do arquivo do gravador).
   * D = tempo no gravador − tempo na câmera, em segundos.
   */
  function matchWindow(mouth, startSec, T, fps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const c = xcorrNorm(highpass(mouth, o.hp), T);
    if (!c) return null;
    const p = peak(c, o.excl);
    return { D: p.i / fps - startSec, r: p.v, ratio: p.ratio, len: c.length, peaks: topPeaks(c, o.topPeaks, o.excl).map((t) => ({ D: t.i / fps - startSec, z: t.z })) };
  }

  /** Os k maiores máximos locais (afastados > excl quadros), com z = (valor − média) / desvio da correlação. */
  function topPeaks(c, k, excl) {
    let s = 0, s2 = 0;
    for (let i = 0; i < c.length; i++) { s += c[i]; s2 += c[i] * c[i]; }
    const mean = s / c.length, sd = Math.sqrt(Math.max(1e-12, s2 / c.length - mean * mean));
    const loc = [];
    for (let i = 1; i < c.length - 1; i++) if (c[i] >= c[i - 1] && c[i] > c[i + 1]) loc.push(i);
    loc.sort((x, y) => c[y] - c[x]);
    const out = [];
    for (const i of loc) {
      if (out.some((t) => Math.abs(t.i - i) <= excl)) continue;
      out.push({ i, z: (c[i] - mean) / sd });
      if (out.length >= k) break;
    }
    return out;
  }

  /**
   * Consenso entre janelas de UM gravador: cada janela entra com suas consPeaks posições de maior z
   * (todas as pessoas); vence a posição que mais janelas apontam (a até agreeFrames). Dois trechos
   * independentes caindo no mesmo quadro por acaso é raro — E2 estima quantos pares assim o acaso daria.
   * @param sets [{ w, len, peaks: [{ D, z }] }] (uma entrada por pessoa × janela)
   * @returns { D, k (janelas), zs, E2 } | null
   */
  function consensus(sets, fps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const tol = o.agreeFrames / fps;
    const wins = [...new Set(sets.map((s) => s.w))];
    if (wins.length < 2) return null;
    const M = Math.min(...sets.map((s) => s.len));
    const all = [];
    for (const w of wins) {
      const ps = [];
      for (const s of sets) if (s.w === w) for (const p of s.peaks) ps.push({ w, D: p.D, z: p.z });
      ps.sort((a, b) => b.z - a.z);
      const kept = [];
      for (const p of ps) { if (kept.some((k) => Math.abs(k.D - p.D) <= tol)) continue; kept.push(p); if (kept.length >= o.consPeaks) break; }
      all.push(...kept);
    }
    let best = null;
    for (const a of all) {
      const near = all.filter((p) => Math.abs(p.D - a.D) <= tol);
      const ws = [...new Set(near.map((p) => p.w))];
      if (ws.length < 2) continue;
      const pick = ws.map((w) => near.filter((p) => p.w === w).reduce((x, y) => (y.z > x.z ? y : x)));
      const zs = pick.reduce((s, p) => s + p.z, 0);
      if (!best || ws.length > best.k || (ws.length === best.k && zs > best.zs)) {
        const Ds = pick.map((p) => p.D).sort((x, y) => x - y);
        best = { D: Ds[Math.floor(Ds.length / 2)], k: ws.length, zs };
      }
    }
    if (!best) return null;
    const W = wins.length;
    best.E2 = ((W * (W - 1)) / 2) * o.consPeaks * o.consPeaks * (2 * o.agreeFrames + 1) / Math.max(1, M);
    return best;
  }

  /**
   * Decisão final com o consenso: Lavanda do decide fica; 3+ janelas concordando → Lavanda;
   * 2 janelas (com pouca chance de acaso) → Pêssego, ou Lavanda se o decide já apontava o mesmo lugar.
   * Janela forte (≥ lavRatio) apontando outro lugar no mesmo gravador → no máximo Pêssego.
   * @param decision resultado do decide (com target) ou null · cons resultado do consensus (com target) ou null
   * @param results os melhores por janela ({ D, ratio, target })
   */
  function withConsensus(decision, cons, results, fps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (decision && decision.level === "synced") return decision;
    if (!cons) return decision;
    const tol = o.agreeFrames / fps;
    const same = decision && decision.target === cons.target && Math.abs(decision.D - cons.D) <= tol;
    let level = null;
    if (cons.k >= 3) level = "synced";
    else if (cons.E2 <= o.consMaxChance) level = same ? "synced" : "review";
    if (!level) return decision;
    const against = results.some((r) => r.target === cons.target && r.ratio >= o.lavRatio && Math.abs(r.D - cons.D) > tol);
    if (against) level = "review";
    return {
      D: same ? decision.D : cons.D, ratio: Math.max(decision ? decision.ratio : 0, level === "synced" ? o.lavRatio : o.minRatio),
      windows: cons.k, agree: true, level, target: cons.target, consensus: cons.k,
    };
  }

  /**
   * Varredura rápida → trechos com mais fala.
   * @param scan [{ t, open: [abertura por pessoa ou NaN] }] ordenado por t (s de mídia)
   * @param dur duração do arquivo (s)
   * @returns [{ start, end, person, score }] do melhor para o pior, sem sobreposição
   */
  function speechWindows(scan, dur, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const win = Math.min(o.winSec, dur);
    if (!scan.length || win <= 0) return [];
    const nP = Math.max(...scan.map((s) => s.open.length));
    const cands = [];
    for (let st = 0; st + win <= dur + 1e-6; st += o.stepSec) {
      const inWin = scan.filter((s) => s.t >= st && s.t < st + win);
      if (!inWin.length) continue;
      for (let p = 0; p < nP; p++) {
        let talk = 0, seen = 0;
        for (const s of inWin) { const v = s.open[p]; if (v == null || Number.isNaN(v)) continue; seen++; if (v > o.speakOpen) talk++; }
        if (seen < inWin.length * 0.5) continue;
        const score = talk / inWin.length;
        if (score >= o.minSpeech) cands.push({ start: st, end: st + win, person: p, score });
      }
      if (st + win >= dur) break;
    }
    cands.sort((x, y) => y.score - x.score);
    const out = [];
    for (const c of cands) {
      if (out.some((w) => c.start < w.end && w.start < c.end)) continue;
      out.push(c);
      if (out.length >= o.maxWindows) break;
    }
    return out;
  }

  /**
   * Junta os resultados das janelas. Retorna null (nada confiável) ou
   * { D, ratio, windows, agree, level: "synced" | "review" }.
   */
  function decide(results, fps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const ok = results.filter((r) => r && r.ratio >= o.minRatio);
    if (!ok.length) return null;
    const tol = o.agreeFrames / fps;
    let best = null;
    for (const r of ok) {
      const cl = ok.filter((x) => Math.abs(x.D - r.D) <= tol);
      const w = cl.reduce((s, x) => s + x.ratio, 0);
      if (!best || cl.length > best.cl.length || (cl.length === best.cl.length && w > best.w)) best = { cl, w };
    }
    const Ds = best.cl.map((x) => x.D).sort((x, y) => x - y);
    const D = Ds[Math.floor(Ds.length / 2)];
    const ratio = Math.max(...best.cl.map((x) => x.ratio));
    // janelas fortes que discordam do consenso = dúvida
    const against = ok.filter((x) => Math.abs(x.D - D) > tol && x.ratio >= o.lavRatio).length;
    const agree = best.cl.length >= 2;
    const level = !against && (agree || ratio >= o.lavRatio) ? "synced" : "review";
    return { D, ratio, windows: best.cl.length, agree, level };
  }

  return { DEFAULTS, frameEnvelope, highpass, fft, prepareTarget, xcorrNorm, peak, matchWindow, topPeaks, consensus, withConsensus, speechWindows, decide };
});
