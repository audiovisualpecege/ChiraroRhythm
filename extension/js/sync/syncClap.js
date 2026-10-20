/**
 * syncClap.js — claquete: a batida na imagem × o estalo no gravador
 * (cálculo puro, sem ffmpeg; testável em Node). 1º passo da sincronização
 * por imagem; a boca só entra se a claquete não resolver (claquete > boca).
 *
 *  - VisualClapSink: recebe os quadros em cinza do começo do vídeo, um por
 *    vez, e guarda só a diferença entre quadros numa grade de células.
 *    A batida = movimento rápido que PARA de repente (a ripa encosta), e é o
 *    primeiro evento assim depois de ~0,5 s de imagem quase parada (a
 *    claquete mostrada para a câmera). O que vem logo depois (tirar a
 *    claquete da frente) também "para", mas chega com movimento antes.
 *    Medido 13/10 (4 câmeras, 4K): batida com "quiet" 0,13–0,18; retirada ≥ 0,32.
 *  - recorderClaps: estalos do gravador no envelope do syncAudio (dB a cada
 *    2 ms): subida forte e queda rápida. Medido 13/10: claquete +29,8 dB e
 *    −26 dB em 150 ms; fala/batidas no mesmo arquivo ≤ +19,6 dB.
 *  - pickByMouth: com vários estalos possíveis, a correlação boca × voz
 *    escolhe entre eles (não precisa de pico claro, só de comparar posições).
 *
 * Convenção: D = tempo no gravador − tempo na câmera (s), como o AESyncVisualMatch.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncClap = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULTS = {
    scanSec: 20, // só o começo do vídeo
    width: 480, // quadro reduzido (altura pela proporção)
    cell: 12, // células de 12×12 px
    moveRatio: 6, // célula "mexeu": diferença ≥ 6× o ruído dela
    stopRatio: 0.25, // e nos 3 quadros seguintes cai para < 25% disso
    minScore: 5, // força mínima do evento
    relScore: 0.1, // e ≥ 10% do evento mais forte do trecho
    preFrames: 20, // "antes parado": quadros t−20 … t−4
    quietMax: 0.25, // movimento antes (p90) / movimento no evento
    burstFrames: 5, // paradas a ≤ 5 quadros uma da outra = a mesma batida (medido: retirada vem ≥ 12 q depois)
    // gravador
    jumpDb: 18, // subida mínima sobre o máximo dos 60 ms anteriores
    decayDb: 10, // queda mínima em 120–160 ms (estalo morre rápido; vogal não)
    nearBestDb: 6, // candidatos: até 6 dB abaixo do estalo mais forte do arquivo
    // regra B (usuário 14/10): claquete sozinha é Lavanda se a câmera está parada e a duração bate com a tomada
    movingRaw: 1.0, // dif. média crua (480 px cinza) acima disso = câmera em movimento (medido: paradas 0,39–0,85; gimbal mexendo 1,17–2,85)
    maxDurDiff: 30, // câmera × tomada com mais de 30 s de diferença: a câmera pode ter começado muito antes (batida fora dos 20 s)
    // escolha pela boca
    mouthMin: 0.15, // correlação mínima no candidato escolhido
    mouthLead: 1.5, // e ≥ 1,5× o 2º candidato
  };

  /**
   * Acumula a diferença entre quadros por célula.
   * push(gray: Uint8Array w×h, t: s no arquivo) — na ordem.
   */
  function VisualClapSink(w, h, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    this.o = o;
    this.w = w; this.h = h;
    this.gx = Math.floor(w / o.cell); this.gy = Math.floor(h / o.cell);
    this.prev = null;
    this.D = []; // por quadro: Float32Array(nc) (o 1º é zero)
    this.t = [];
  }
  VisualClapSink.prototype.push = function (gray, t) {
    const { w, gx, gy } = this, c = this.o.cell, nc = gx * gy;
    const d = new Float32Array(nc);
    if (this.prev) {
      const p = this.prev;
      for (let cy = 0; cy < gy; cy++) {
        for (let y = cy * c; y < (cy + 1) * c; y++) {
          const row = y * w;
          for (let cx = 0; cx < gx; cx++) {
            let s = 0;
            for (let x = cx * c, e = x + c; x < e; x++) { const v = gray[row + x] - p[row + x]; s += v < 0 ? -v : v; }
            d[cy * gx + cx] += s;
          }
        }
      }
      for (let k = 0; k < nc; k++) d[k] /= c * c;
    }
    this.prev = gray.slice ? gray.slice() : Uint8Array.from(gray);
    this.D.push(d);
    this.t.push(t);
  };

  /**
   * Procura a batida. Retorna null ou
   * { t: instante do contato (s no arquivo), frame, score, quiet, events }.
   * O contato fica entre o último quadro em movimento e o 1º parado → t do quadro − ½ quadro.
   */
  VisualClapSink.prototype.result = function (fps) {
    const o = this.o, D = this.D, n = D.length, nc = this.gx * this.gy;
    if (n < o.preFrames + 8) return null;
    // ruído por célula = mediana no tempo
    const noise = new Float32Array(nc);
    const col = new Float32Array(n - 1);
    for (let c = 0; c < nc; c++) {
      for (let t = 1; t < n; t++) col[t - 1] = D[t][c];
      const s = Array.from(col).sort((a, b) => a - b);
      noise[c] = s[s.length >> 1] + 0.5;
    }
    const S = new Float32Array(n), G = new Float32Array(n);
    for (let t = 1; t < n; t++) {
      let g = 0;
      for (let c = 0; c < nc; c++) { const r = D[t][c] / noise[c]; if (r > 3) g += r; }
      G[t] = g;
    }
    for (let t = 2; t < n - 4; t++) {
      let s = 0;
      for (let c = 0; c < nc; c++) {
        const now = Math.max(D[t][c], D[t - 1][c]) / noise[c];
        if (now <= o.moveRatio) continue;
        const after = Math.max(D[t + 1][c], D[t + 2][c], D[t + 3][c]) / noise[c];
        if (after < now * o.stopRatio) s += Math.log(now / Math.max(after, 1));
      }
      S[t] = s;
    }
    const events = [];
    let maxS = 0;
    for (let t = Math.max(2, o.preFrames); t < n - 4; t++) {
      if (!(S[t] > 0 && S[t] >= S[t - 1] && S[t] >= S[t + 1] && S[t] >= S[t - 2] && S[t] >= (S[t + 2] || 0))) continue;
      const gNow = Math.max(G[t], G[t - 1]);
      const pre = [];
      for (let j = t - o.preFrames; j <= t - 4; j++) pre.push(G[j]);
      pre.sort((a, b) => a - b);
      const quiet = pre[Math.floor((pre.length - 1) * 0.9)] / (gNow + 1);
      events.push({ frame: t, score: S[t], quiet });
      maxS = Math.max(maxS, S[t]);
    }
    // movimento geral da imagem: fração de células mexendo (> 3× ruído próprio) e diferença média crua
    // por quadro, mediana no tempo — câmera em movimento (gimbal) mexe tudo o tempo todo
    {
      const frac = [], raw = [];
      for (let t = 1; t < n; t++) {
        let moving = 0, sum = 0;
        for (let c = 0; c < nc; c++) { sum += D[t][c]; if (D[t][c] > 3 * noise[c] + 2) moving++; }
        frac.push(moving / nc); raw.push(sum / nc);
      }
      const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
      this.motion = { frac: med(frac), raw: med(raw), noise: med(Array.from(noise)) };
    }
    const strong = events.filter((e) => e.score >= Math.max(o.minScore, o.relScore * maxS));
    this.lastEvents = strong.map((e) => ({ t: this.t[e.frame] - 0.5 / fps, frame: e.frame, score: e.score, quiet: e.quiet }));
    let k = strong.findIndex((e) => e.quiet <= o.quietMax);
    if (k < 0) return null;
    // a mesma descida da ripa pode deixar paradas seguidas: o contato é a última da rajada.
    // Quadros vizinhos são a MESMA parada vista duas vezes (o placar usa D[t] e D[t−1]) → fica o 1º.
    while (k + 1 < strong.length) {
      const gap = strong[k + 1].frame - strong[k].frame;
      if (gap < 2 || gap > o.burstFrames) break;
      k++;
    }
    const hit = strong[k];
    // contato ≈ meio quadro antes do 1º quadro já parado (conferido pela boca: 0,1–0,7 q)
    return { t: this.t[hit.frame] - 0.5 / fps, frame: hit.frame, score: hit.score, quiet: hit.quiet, events: strong.length };
  };

  /**
   * Estalos de claquete no envelope do gravador.
   * @param env Float32Array dB a cada envMs
   * @returns [{ t (s), jump, decay, peak }] em ordem de tempo, só os parecidos com o mais forte
   */
  function recorderClaps(env, envMs, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const per = (ms) => Math.max(1, Math.round(ms / envMs));
    const back = per(60), look = per(10), d0 = per(120), d1 = per(160), skip = per(200);
    const out = [];
    for (let i = back; i < env.length - d1; i++) {
      let prev = -Infinity;
      for (let j = i - back; j < i - 1; j++) if (env[j] > prev) prev = env[j];
      if (env[i] - prev < o.jumpDb * 0.6) continue; // filtro rápido
      let pk = -Infinity, pi = i;
      for (let j = i; j < i + look; j++) if (env[j] > pk) { pk = env[j]; pi = j; }
      const jump = pk - prev;
      if (jump < o.jumpDb) continue;
      let tail = -Infinity;
      for (let j = pi + d0; j < Math.min(env.length, pi + d1); j++) if (env[j] > tail) tail = env[j];
      const decay = pk - tail;
      if (decay >= o.decayDb) out.push({ t: (i * envMs) / 1000, jump, decay, peak: pk });
      i += skip;
    }
    if (!out.length) return out;
    const best = Math.max(...out.map((c) => c.jump));
    return out.filter((c) => c.jump >= best - o.nearBestDb);
  }

  /**
   * Vários estalos possíveis: a boca escolhe.
   * @param corr curva de correlação boca × gravador (AESyncVisualMatch.xcorrNorm), índice L = quadro do gravador onde cai o 1º quadro da série
   * @param startSec tempo na câmera do 1º quadro da série
   * @param Ds [D] candidatos
   * @returns { i, r, lead } ou null
   */
  function pickByMouth(corr, startSec, fps, Ds, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!corr) return null;
    const vals = Ds.map((D) => {
      const L = Math.round((D + startSec) * fps);
      let m = -Infinity;
      for (let d = -2; d <= 2; d++) if (L + d >= 0 && L + d < corr.length) m = Math.max(m, corr[L + d]);
      return m;
    });
    let i = -1;
    vals.forEach((v, k) => { if (v > -Infinity && (i < 0 || v > vals[i])) i = k; });
    if (i < 0) return null;
    const second = Math.max(0.02, ...vals.filter((_, k) => k !== i).map((v) => (v === -Infinity ? 0 : v)));
    const lead = vals[i] / second;
    return vals[i] >= o.mouthMin && lead >= o.mouthLead ? { i, r: vals[i], lead } : null;
  }

  /**
   * Qual tomada do gravador é de cada arquivo da câmera (aparelhos em faixas, na
   * ordem de gravação — decisão do usuário 13/10). Alinhamento global (DP) das
   * duas listas pela semelhança de duração: câmera e gravador de uma tomada
   * começam e param juntos; pular arquivo ou tomada é permitido; nunca volta.
   * Medido 13/10 (57 câmeras × 21 tomadas): 49/50 pares certos.
   * @returns { take: [índice da tomada ou −1 por arquivo], score }
   */
  function alignTakes(camDurs, takeDurs, opts) {
    const o = Object.assign({ simMin: 0.6 }, opts || {});
    const n = camDurs.length, m = takeDurs.length;
    const sim = (a, b) => (a > 0 && b > 0 ? 1 - Math.abs(a - b) / Math.max(a, b) : 0);
    const F = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (!i && !j) continue;
        let best = -Infinity, how = 0;
        if (i && F[i - 1][j] > best) { best = F[i - 1][j]; how = 1; }
        if (j && F[i][j - 1] > best) { best = F[i][j - 1]; how = 2; }
        if (i && j) {
          const s = sim(camDurs[i - 1], takeDurs[j - 1]);
          if (s >= o.simMin) {
            const v = F[i - 1][j - 1] + (s - o.simMin) / (1 - o.simMin);
            if (v > best) { best = v; how = 3; }
          }
        }
        F[i][j] = best; B[i][j] = how;
      }
    }
    const take = new Array(n).fill(-1);
    for (let i = n, j = m; i || j;) {
      const h = B[i][j];
      if (h === 3) { take[i - 1] = j - 1; i--; j--; } else if (h === 1) i--; else j--;
    }
    return { take, score: F[n][m] };
  }

  /**
   * Com a tomada conhecida: a claquete daquele par. 1º evento "parecido com
   * batida" (quiet ≤ 0,4) que tenha estalo no começo da tomada; entre os
   * estalos, o que deixa câmera e gravador começando mais juntos (|D| menor).
   * @param events eventos da imagem (VisualClapSink.lastEvents), em ordem de tempo
   * @param claps estalos da tomada (recorderClaps)
   * @returns { D, t, k } ou null
   */
  function clapInTake(events, claps, opts) {
    const o = Object.assign({ quiet: 0.4, earlySec: 25 }, opts || {});
    const early = claps.filter((k) => k.t < o.earlySec);
    for (const e of events || []) {
      if (e.quiet > o.quiet) continue;
      let best = null;
      for (const k of early) { const D = k.t - e.t; if (!best || Math.abs(D) < Math.abs(best.D)) best = { D, t: e.t, k }; }
      if (best) return best;
    }
    return null;
  }

  /**
   * A boca confirma a posição da claquete? Correlação perto do D da claquete
   * (±2 quadros) tem que ser o pico da tomada: ≥ mouthMin e ≥ confirmLead × o
   * melhor valor fora de ±excl quadros. (Regra A do usuário: claquete só é
   * Lavanda com a boca confirmando.)
   */
  function confirmByMouth(corr, startSec, fps, D, opts) {
    const o = Object.assign({ mouthMin: 0.1, confirmLead: 1.2, excl: 15 }, opts || {});
    if (!corr) return null;
    const L = Math.round((D + startSec) * fps);
    let r = -Infinity;
    for (let d = -2; d <= 2; d++) if (L + d >= 0 && L + d < corr.length) r = Math.max(r, corr[L + d]);
    if (r === -Infinity) return null;
    let second = 0.02;
    for (let i = 0; i < corr.length; i++) if (Math.abs(i - L) > o.excl && corr[i] > second) second = corr[i];
    const lead = r / second;
    return { r, lead, ok: r >= o.mouthMin && lead >= o.confirmLead };
  }

  return { DEFAULTS, VisualClapSink, recorderClaps, pickByMouth, alignTakes, clapInTake, confirmByMouth };
});
