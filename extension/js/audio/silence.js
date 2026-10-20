/**
 * silence.js
 *
 * Lógica pura (sem Premiere, sem disco) do Cortador de Silêncios:
 *  1. monta o envelope da TIMELINE juntando os envelopes de cada clipe
 *     (posição, in point e velocidade de cada um), pegando o mais alto
 *     entre as faixas analisadas;
 *  2. detecta os silêncios com os parâmetros do usuário;
 *  3. alinha cada corte aos frames da sequência.
 *
 * Como o envelope fica em memória, mudar qualquer parâmetro recalcula os
 * cortes na hora, sem ler o áudio de novo.
 */
(function (root, factory) {
  const api = factory();
  root.AESilence = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const EPS = 1e-6;

  function toDb(meanSquare) {
    return meanSquare > 1e-12 ? 10 * Math.log10(meanSquare) : -120;
  }

  /**
   * @param items [{ tStart, tEnd, srcIn, speed, env: { startSec, ms } }] tempos em segundos
   * @returns {{ startSec, endSec, ms: Float32Array, covered: Uint8Array }} 1 valor por ms de timeline
   */
  function buildTimeline(items, fromSec, toSec) {
    const n = Math.max(0, Math.ceil((toSec - fromSec) * 1000 - EPS));
    const ms = new Float32Array(n);
    const covered = new Uint8Array(n);
    for (const it of items) {
      const k0 = Math.max(0, Math.floor((it.tStart - fromSec) * 1000 + EPS));
      const k1 = Math.min(n, Math.ceil((it.tEnd - fromSec) * 1000 - EPS));
      if (it.keep) {
        // Clipe que não deu para ler: tratado como fala, nunca é cortado
        for (let k = k0; k < k1; k++) {
          ms[k] = Math.max(ms[k], 1);
          covered[k] = 1;
        }
        continue;
      }
      if (!it.env || !it.env.ms) continue;
      const env = it.env.ms;
      const speed = it.speed || 1;
      for (let k = k0; k < k1; k++) {
        const t = fromSec + (k + 0.5) / 1000;
        const src = it.srcIn + (t - it.tStart) * speed;
        const idx = Math.floor((src - it.env.startSec) * 1000);
        covered[k] = 1;
        if (idx >= 0 && idx < env.length) {
          const v = env[idx];
          if (v > ms[k]) ms[k] = v;
        }
      }
    }
    return { startSec: fromSec, endSec: fromSec + n / 1000, ms, covered };
  }

  /** dB por janela de análise. */
  function windowLevels(tl, windowMs) {
    const w = Math.max(1, Math.round(windowMs));
    const n = tl.ms.length;
    const count = Math.ceil(n / w);
    const db = new Float32Array(count);
    const cov = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = i * w;
      const b = Math.min(n, a + w);
      let s = 0;
      let c = 0;
      for (let k = a; k < b; k++) {
        s += tl.ms[k];
        c += tl.covered[k];
      }
      db[i] = toDb(s / (b - a));
      cov[i] = c / (b - a);
    }
    return { w, db, cov };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  }

  /**
   * Sugere um limiar olhando a distribuição de níveis: ruído de fundo
   * (percentil 10) e fala (percentil 90). O limiar fica a 35% do caminho
   * entre os dois — perto o bastante do ruído para não comer finais de
   * palavras, longe o bastante para pegar pausas com ruído de sala.
   */
  function suggestThresholdDb(tl, windowMs) {
    const { db, cov } = windowLevels(tl, windowMs || 20);
    const vals = [];
    for (let i = 0; i < db.length; i++) if (cov[i] > 0.5 && db[i] > -100) vals.push(db[i]);
    if (vals.length < 10) return { thresholdDb: -40, noiseDb: null, speechDb: null };
    vals.sort((a, b) => a - b);
    const noise = percentile(vals, 0.1);
    const speech = percentile(vals, 0.9);
    let thr = speech - noise < 8 ? speech - 6 : noise + 0.35 * (speech - noise);
    thr = Math.round(Math.max(-70, Math.min(-12, thr)));
    return { thresholdDb: thr, noiseDb: noise, speechDb: speech };
  }

  /**
   * @param p { thresholdDb, windowMs, minSilenceSec, marginAfterMs, marginBeforeMs, fps, allowed?: [{startSec,endSec}] }
   * @returns {{ cuts: [{ startFrame, endFrame, startSec, endSec, durationSec }], totalCutSec }}
   */
  function detect(tl, p) {
    const { w, db } = windowLevels(tl, p.windowMs);
    const minSil = p.minSilenceSec;
    const mA = p.marginAfterMs / 1000;
    const mB = p.marginBeforeMs / 1000;
    const rangeStart = tl.startSec;
    const rangeEnd = tl.endSec;
    const n = tl.ms.length;

    const raw = [];
    let runStart = -1;
    for (let i = 0; i <= db.length; i++) {
      const silent = i < db.length && db[i] < p.thresholdDb;
      if (silent && runStart < 0) runStart = i;
      if (!silent && runStart >= 0) {
        const s = rangeStart + (runStart * w) / 1000;
        const e = rangeStart + Math.min(n, i * w) / 1000;
        if (e - s >= minSil - EPS) raw.push({ s, e });
        runStart = -1;
      }
    }

    const allowed = p.allowed && p.allowed.length ? p.allowed : [{ startSec: rangeStart, endSec: rangeEnd }];
    const cuts = [];
    for (const r of raw) {
      // Sem fala antes (início do trecho) não precisa de margem "depois da fala"; idem no fim.
      const cs = r.s <= rangeStart + EPS ? r.s : r.s + mA;
      const ce = r.e >= rangeEnd - EPS ? r.e : r.e - mB;
      if (ce <= cs) continue;
      for (const a of allowed) {
        const s = Math.max(cs, a.startSec);
        const e = Math.min(ce, a.endSec);
        if (e <= s) continue;
        const sf = Math.ceil(s * p.fps - 1e-4);
        const ef = Math.floor(e * p.fps + 1e-4);
        if (ef - sf < 1) continue;
        cuts.push({ startFrame: sf, endFrame: ef, startSec: sf / p.fps, endSec: ef / p.fps, durationSec: (ef - sf) / p.fps });
      }
    }
    cuts.sort((a, b) => a.startFrame - b.startFrame);
    // Junta cortes que se encostam (pode acontecer com faixas permitidas vizinhas)
    const merged = [];
    for (const c of cuts) {
      const last = merged[merged.length - 1];
      if (last && c.startFrame <= last.endFrame) {
        last.endFrame = Math.max(last.endFrame, c.endFrame);
        last.endSec = last.endFrame / p.fps;
        last.durationSec = (last.endFrame - last.startFrame) / p.fps;
      } else merged.push(c);
    }
    const totalCutSec = merged.reduce((acc, c) => acc + c.durationSec, 0);
    return { cuts: merged, totalCutSec };
  }

  return { toDb, buildTimeline, windowLevels, suggestThresholdDb, detect };
});
