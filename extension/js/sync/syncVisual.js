/**
 * syncVisual.js — sincronização por imagem (claquete → "boca × voz") no painel.
 *
 * Etapa separada, desligada por padrão: roda DEPOIS do áudio e só nos clipes
 * de câmera que o áudio não resolveu. Para cada arquivo de câmera:
 *   0. claquete (AESyncClap): batida no começo do vídeo × estalo no gravador.
 *      Um único par coerente → pronto (Lavanda), sem rodar a boca. Vários
 *      estalos → a boca escolhe; sem boca → o mais provável, para revisar.
 *   1. acha as pessoas (lupa): 4 quadros inteiros, recortes quadrados em 3
 *      escalas → rostos; cada pessoa vira um recorte quadrado fixo
 *      (o detector do MediaPipe perde rosto pequeno — medido 08/10);
 *   2. varredura: só os quadros-chave do arquivo, abertura da boca por pessoa;
 *   3. os 2 min em que alguém mais fala (ou o clipe inteiro, se for curto);
 *   4. todos os quadros desse trecho → série da boca → correlação com o
 *      envelope de cada gravador (AESyncVisualMatch);
 *   5. "analisar a fundo": até 4 trechos, que precisam concordar.
 * Resultado = casamento no mesmo formato do áudio (AESyncMatch), com
 * visual: "boca" e review conforme a força.
 *
 * Depende de: AESyncFfmpeg, AESyncVisualMatch, AESyncAudio (ENV_MS).
 */
(function (root) {
  let pathMod = null, os = null;
  let fsMod = null;
  try { pathMod = require("path"); os = require("os"); fsMod = require("fs"); } catch (e) {}
  const VM = root.AESyncVisualMatch;
  const FF = root.AESyncFfmpeg;
  const CL = root.AESyncClap;
  const SL = root.AESyncSlate;
  const BLOCK = 30; // quadros seguidos no mesmo worker (o rastreio do rosto continua)
  const SIZE = 320;

  function workerUrl() {
    let p = decodeURIComponent(window.location.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return encodeURI("file:///" + pathMod.join(pathMod.dirname(p), "js", "sync", "syncFaceWorker.js").replace(/\\/g, "/"));
  }

  /** Conjunto de workers de rosto. */
  function createPool(n, url) {
    const workers = [];
    let nextId = 1;
    const waiting = new Map();
    const load = new Array(n).fill(0);
    const start = Promise.all(
      Array.from({ length: n }, (_, k) => new Promise((res, rej) => {
        const w = new Worker(url, { type: "module" });
        w.onerror = (e) => rej(new Error("worker de rosto: " + (e.message || "não carregou")));
        w.onmessage = (e) => {
          const m = e.data;
          if ("ready" in m) {
            if (m.ready) res(w); else rej(new Error("MediaPipe: " + m.error));
            return;
          }
          const cb = waiting.get(m.id);
          if (!cb) return;
          waiting.delete(m.id);
          load[k]--;
          if (m.error) cb.rej(new Error(m.error)); else cb.res(m);
        };
        workers[k] = w;
      }))
    );
    function send(k, msg, transfer) {
      const id = nextId++;
      load[k]++;
      return new Promise((res, rej) => {
        waiting.set(id, { res, rej });
        workers[k].postMessage(Object.assign({ id }, msg), transfer || []);
      });
    }
    return {
      size: n,
      ready: start,
      send,
      load,
      close() { workers.forEach((w) => w && w.terminate()); },
    };
  }

  const toAB = (buf) => { const u = new Uint8Array(buf.length); u.set(buf); return u; };

  /**
   * @param opts { workers?, ffmpegExe? (testes), workerUrl? (testes) }
   */
  function create(opts) {
    const cores = (os && os.cpus().length) || navigator.hardwareConcurrency || 4;
    const o = Object.assign({ workers: Math.max(2, Math.min(12, cores - 2)) }, opts);
    const ff = o.ffmpegExe ? FF.check(o.ffmpegExe) || { ok: false, reason: "ffmpeg inválido" } : FF.find();
    if (!ff.ok) throw new Error(ff.reason);
    const pool = createPool(o.workers, o.workerUrl || workerUrl());
    const targets = new Map(); // chave+fps -> alvo preparado

    /** Envelope do gravador por quadro, com passa-alta, preparado para a FFT. */
    function targetFor(key, feat, fps, maxFrames) {
      const k = key + "@" + fps.toFixed(3);
      let t = targets.get(k);
      if (!t || t.max < maxFrames) {
        const env = VM.highpass(VM.frameEnvelope(feat.env, feat.envMs || root.AESyncAudio.ENV_MS, fps), VM.DEFAULTS.hp);
        t = { T: VM.prepareTarget(env, maxFrames), max: maxFrames };
        targets.set(k, t);
      }
      return t.T;
    }

    // ------------------------------------------------------------ 1. achar pessoas
    async function findPeople(file, info, signal, range) {
      const H = info.h, W = info.w;
      const tiles = [];
      for (const S of [H, H / 2, H / 3].map(Math.round)) {
        for (let y = 0; y + S <= H; y += Math.round(S / 2)) for (let x = 0; x + S <= W; x += Math.round(S / 2)) tiles.push({ x, y, s: S });
        // borda direita/de baixo
        if ((W - S) % Math.round(S / 2)) for (let y = 0; y + S <= H; y += Math.round(S / 2)) tiles.push({ x: W - S, y, s: S });
      }
      const hits = [];
      // com trecho definido (tomada conhecida), os quadros vêm só dele
      const r0 = range ? range.start : 0, r1 = range ? range.end : info.dur;
      const times = [0.12, 0.37, 0.62, 0.87].map((f) => Math.max(0, Math.min(info.dur - 0.5, r0 + (r1 - r0) * f)));
      let si = 0;
      for (const t of times) {
        if (signal.cancelled) throw new Error("cancelado");
        let still = null;
        await FF.frames(ff.exe, file, info, { ss: t, still: true }, (j) => (still = j));
        if (!still) continue;
        const per = Math.ceil(tiles.length / pool.size);
        const parts = [];
        for (let k = 0; k < pool.size; k++) {
          const mine = tiles.slice(k * per, (k + 1) * per);
          if (mine.length) parts.push(pool.send(k, { type: "tiles", jpeg: toAB(still), tiles: mine }));
        }
        for (const r of await Promise.all(parts)) for (const f of r.faces) hits.push(Object.assign({ still: si }, f));
        si++;
      }
      // mesma pessoa = centros a menos de 1 altura de rosto; precisa aparecer em ≥ 2 quadros
      const groups = [];
      for (const h of hits) {
        const g = groups.find((g) => Math.hypot(g.cx - h.cx, g.cy - h.cy) < Math.max(g.fh, h.fh));
        if (g) { g.n++; g.cx += (h.cx - g.cx) / g.n; g.cy += (h.cy - g.cy) / g.n; g.fh = Math.max(g.fh, h.fh); g.stills.add(h.still); }
        else groups.push(Object.assign({}, h, { n: 1, stills: new Set([h.still]) }));
      }
      return groups
        .filter((g) => g.stills.size >= 2)
        .sort((a, b) => b.fh - a.fh)
        .slice(0, 4)
        .map((g) => {
          const s = Math.round(Math.min(H, Math.max(160, g.fh * 2.6)));
          return { x: Math.round(Math.max(0, Math.min(W - s, g.cx - s / 2))), y: Math.round(Math.max(0, Math.min(H - s, g.cy - s / 2))), s, fh: Math.round(g.fh) };
        });
    }

    // ------------------------------------------------------------ 2/4. quadros → boca
    /**
     * Passa os quadros do ffmpeg pelos workers (blocos contíguos) e devolve
     * [{ t, open: [por pessoa] }] na ordem.
     */
    async function mouthSeries(file, info, crops, fopts, signal, onFrames, lane) {
      const out = [];
      const pending = [];
      let f = 0;
      const flow = {};
      // lane = faixa de workers deste arquivo (2 arquivos ao mesmo tempo não misturam o rastreio do rosto)
      const l0 = lane ? lane.from : 0, ln = lane ? Math.max(1, lane.count) : pool.size;
      fopts = Object.assign({}, fopts, { crops, size: SIZE, signal, flow });
      await FF.frames(ff.exe, file, info, fopts, (jpeg, t) => {
        const k = l0 + (Math.floor(f / BLOCK) % ln);
        const idx = f++;
        const pr = pool.send(k, { type: "frame", jpeg: toAB(jpeg), k: crops.length }).then((r) => { out[idx] = { t, open: r.open }; if (onFrames) onFrames(out.length); });
        pending.push(pr);
        // contrapressão: o ffmpeg decodifica mais rápido que os detectores
        if (pool.load[k] > 4 * BLOCK) {
          Promise.race([pr]).then(() => flow.resume && flow.resume());
          return true;
        }
        return false;
      });
      await Promise.all(pending);
      return out.filter(Boolean);
    }

    // ------------------------------------------------------------ 0. claquete
    const clapCache = new Map(); // gravador -> estalos
    function recorderClaps(tg) {
      if (!clapCache.has(tg.key)) clapCache.set(tg.key, CL.recorderClaps(tg.feat.env, tg.feat.envMs || root.AESyncAudio.ENV_MS));
      return clapCache.get(tg.key);
    }

    /** Claquete no começo do vídeo (só a imagem): { hit: batida escolhida ou null, events: todas as paradas fortes }. */
    async function findClap(file, info, signal) {
      let sink = null;
      await FF.gray(ff.exe, file, info, { t: CL.DEFAULTS.scanSec, w: CL.DEFAULTS.width, signal }, (gray, t) => {
        if (!sink) sink = new CL.VisualClapSink(CL.DEFAULTS.width, gray.length / CL.DEFAULTS.width);
        sink.push(gray, t);
      });
      if (!sink) return null;
      const hit = sink.result(info.fps);
      return { hit, events: sink.lastEvents || [], motion: sink.motion || null };
    }

    const durCache = new Map();
    /** Duração do arquivo (s) pelo cabeçalho; null se ilegível. */
    function duration(file) {
      if (!durCache.has(file)) {
        let d = null;
        try { d = FF.probe(ff.exe, file).dur || null; } catch (e) {}
        durCache.set(file, d);
      }
      return durCache.get(file);
    }

    /**
     * Pares batida × estalo. Uma tomada com claquete tem câmera e gravador
     * rodando juntos → ficam os pares com sobreposição perto da melhor
     * (medido 13/10: o estalo do fim do arquivo daria 7 de 59 s juntos).
     */
    function clapCandidates(clap, info, tlist) {
      const out = [];
      for (const tg of tlist) {
        const recDur = tg.feat.durationSec || (tg.feat.env.length * (tg.feat.envMs || 2)) / 1000;
        for (const c of recorderClaps(tg)) {
          const D = c.t - clap.t;
          const over = Math.max(0, Math.min(info.dur, recDur - D) - Math.max(0, -D));
          out.push({ D, target: tg.key, jump: c.jump, rt: c.t, fit: over / Math.max(1e-6, Math.min(info.dur, recDur)) });
        }
      }
      const best = Math.max(0, ...out.map((c) => c.fit));
      return out.filter((c) => c.fit >= 0.8 * best && c.fit > 0.25);
    }

    const clapDecision = (c, level) => ({ D: c.D, ratio: level === "synced" ? 4 : 2, windows: 1, agree: true, level, via: "claquete", target: c.target });

    // ------------------------------------------------------------ análise de um arquivo
    /**
     * Cascata: claquete → boca. Regra A do usuário (13/10): a claquete só vira
     * Lavanda com a boca confirmando; sem confirmação, Pêssego.
     * Com a tomada conhecida (a.take = chave do gravador daquele arquivo, pelo
     * alinhamento por ordem/duração), claquete e boca procuram só nela.
     * @param cam { file }
     * @param tlist [{ key, feat }] gravadores candidatos (envelope de áudio do syncAudio)
     * @param a { deep, take?, signal: { cancelled }, onProgress(frac, label) }
     * @returns { decision: { D, ratio, level, target, via } | null, reason, people, windows, clap, ms }
     */
    // ------------------------------------------------------------ claquete reconhecida (segunda opinião)
    let slateRef; // undefined = ainda não lida; null = indisponível
    const slateCache = new Map(); // arquivo → batida reconhecida (ou null)
    function slateReference() {
      if (slateRef !== undefined) return slateRef;
      slateRef = null;
      try {
        if (o.slateRef) slateRef = o.slateRef;
        else if (SL && fsMod && pathMod) {
          let p = decodeURIComponent(window.location.pathname);
          if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
          slateRef = SL.parseRef(fsMod.readFileSync(pathMod.join(pathMod.dirname(p), "img", "claquete-ref.slt")));
        }
      } catch (e) { slateRef = null; }
      return slateRef;
    }

    /**
     * Na tomada conhecida, quando o detector de "movimento que para" não deu Lavanda (câmera em movimento,
     * batida não achada) e a boca também não: procura a claquete da produtora pela referência (AESyncSlate).
     * Achou → Pêssego com a posição dela (D = estalo mais forte do gravador nos 25 s − batida). Não achou →
     * fica o resultado de antes. Câmera parada com Lavanda, palestra e podcast não passam por aqui.
     */
    async function analyzeFile(cam, tlist, a) {
      const r = await analyzeCore(cam, tlist, a);
      if (!a.take || a.slate === false || (r.decision && r.decision.level === "synced")) return r;
      const tg = tlist.find((t) => t.key === a.take);
      const ref = tg && slateReference();
      if (!ref) return r;
      const claps = recorderClaps(tg).filter((c) => c.t <= SL.DEFAULTS.scanSec);
      if (!claps.length) return r;
      let hit = null;
      const t0 = Date.now();
      // o "a fundo" volta às mesmas câmeras: o reconhecimento só depende do arquivo → guardado
      if (slateCache.has(cam.file)) hit = slateCache.get(cam.file);
      else {
        if (a.onProgress) a.onProgress(0.99, "reconhecendo a claquete");
        try {
          hit = await SL.find(FF, ff.exe, cam.file, FF.probe(ff.exe, cam.file), ref, { signal: a.signal || {} });
          slateCache.set(cam.file, hit);
        } catch (e) { if (e.message === "cancelado") throw e; }
      }
      if (!hit) return Object.assign(r, { slateMs: Date.now() - t0 });
      const k = claps.reduce((x, y) => (y.jump > x.jump ? y : x));
      return Object.assign({}, r, {
        decision: clapDecision({ D: k.t - hit.t, target: tg.key }, "review"),
        clap: { t: hit.t }, note: "batida reconhecida pela claquete", reason: "",
        slate: { open: hit.open, closed: hit.closed }, slateMs: Date.now() - t0, ms: (r.ms || 0) + (Date.now() - t0),
      });
    }

    async function analyzeCore(cam, tlist, a) {
      const t0 = Date.now();
      const signal = a.signal || {};
      const prog = a.onProgress || (() => {});
      await pool.ready;
      const info = FF.probe(ff.exe, cam.file);
      if (!info.fps || !info.w) return { decision: null, reason: "vídeo sem fps/tamanho legível" };
      if (a.take) {
        const tg = tlist.find((t) => t.key === a.take);
        if (tg) tlist = [tg];
      }
      prog(0.01, "procurando a claquete");
      let clapRes = null, cands = [];
      try { clapRes = await findClap(cam.file, info, signal); } catch (e) { if (e.message === "cancelado") throw e; }
      const clap = clapRes && clapRes.hit;
      if (a.take && tlist.length === 1) {
        const moving = !!(clapRes && clapRes.motion && clapRes.motion.raw > CL.DEFAULTS.movingRaw);
        const claps = recorderClaps(tlist[0]);
        // câmera em movimento: primeiro o critério rigoroso (parado antes ≤ 0,25), senão o normal —
        // acerta a CHIARO4727 (o normal pegava um balanço aos 3,5 s); em câmera parada o rigoroso
        // trocaria um acerto por erro (552A2207), então lá fica o normal (medido 14/10)
        const p = !clapRes ? null : moving ? CL.clapInTake(clapRes.events, claps, { quiet: 0.25 }) || CL.clapInTake(clapRes.events, claps) : CL.clapInTake(clapRes.events, claps);
        if (p) {
          cands = [{ D: p.D, target: tlist[0].key, jump: p.k.jump, fit: 1, t: p.t }];
          // regra B (usuário 14/10): com a tomada conhecida, a claquete decide sozinha, sem a boca.
          // Câmera parada e duração batendo com a tomada → Lavanda (medido: 20 certos, 1 errado);
          // câmera em movimento (gimbal: 6 de 8 erradas) ou duração muito diferente → Pêssego.
          const takeDur = tlist[0].feat.durationSec || 0;
          const durOff = takeDur > 0 && Math.abs(info.dur - takeDur) > CL.DEFAULTS.maxDurDiff;
          const why = moving ? "câmera em movimento" : durOff ? `duração difere ${Math.abs(info.dur - takeDur).toFixed(0)} s da tomada` : "";
          return {
            decision: clapDecision(cands[0], why ? "review" : "synced"),
            reason: "", note: why, clap: { t: p.t }, motion: clapRes.motion, people: [], ms: Date.now() - t0,
          };
        }
      } else if (clap) cands = clapCandidates(clap, info, tlist);
      // sem confirmação da boca → o par mais provável, para revisar — só com o estalo no começo do gravador
      // (≤ 25 s, como em clapInTake): na palestra um estalo aos 5 min virava "claquete" 320 s fora (14/10)
      const fallback = () => {
        const early = cands.filter((c) => c.rt <= 25);
        if (!early.length) return null;
        const c = early.sort((x, y) => y.fit - x.fit || y.jump - x.jump)[0];
        return clapDecision(c, "review");
      };
      // Tomada conhecida: a boca só confirma/acha dentro de um trecho curto (2.7.1 — a varredura do
      // arquivo inteiro custava até 500 s nos arquivos de 30 min). Com claquete: 60 s logo depois da
      // batida (quando começam a falar); sem: o melhor trecho de fala nos 3 primeiros minutos.
      const takeMode = !!(a.take && tlist.length === 1);
      const winSec = takeMode ? (a.deep ? 120 : 60) : VM.DEFAULTS.winSec;
      let range = null;
      if (takeMode) {
        if (cands.length) {
          const s = Math.max(0, Math.min(cands[0].t + 2, info.dur - winSec));
          range = { start: s, end: Math.min(info.dur, s + winSec) };
        } else range = { start: 0, end: Math.min(info.dur, 180) };
      }
      prog(0.08, "procurando rostos");
      const people = await findPeople(cam.file, info, signal, range);
      if (!people.length) {
        const d = fallback();
        return { decision: d, reason: d ? "" : "sem claquete e sem rosto", clap, people, ms: Date.now() - t0 };
      }
      let windows;
      const span = range || { start: 0, end: info.dur };
      if (span.end - span.start <= winSec * 1.25) windows = [{ start: span.start, end: span.end, person: -1, score: 1 }];
      else {
        prog(0.1, "procurando trechos de fala");
        const nKey = Math.max(1, Math.round(span.end - span.start)); // ~1 quadro-chave por segundo (estimativa só para a barra)
        const scan = await mouthSeries(cam.file, info, people, range ? { keyOnly: true, ss: range.start, t: range.end - range.start } : { keyOnly: true }, signal, (n) => prog(0.1 + 0.4 * Math.min(1, n / nKey), "procurando trechos de fala"), a.lane);
        // normal: até 2 trechos — o 2º só roda se o 1º não der Lavanda (o consenso precisa de 2; podcast 15/10).
        // Na tomada da claquete a normal fica com 1 (gravação curta: o consenso nem vale lá).
        windows = VM.speechWindows(scan.map((s) => ({ t: s.t, open: s.open.map((v) => (v == null ? NaN : v)) })), span.end, { winSec, maxWindows: a.deep ? (takeMode ? 2 : 4) : takeMode ? 1 : 2 });
        if (!windows.length) {
          const d = fallback();
          return { decision: d, reason: d ? "" : "ninguém falando no vídeo", clap, people, ms: Date.now() - t0 };
        }
      }
      const maxFrames = Math.ceil(winSec * 1.25 * info.fps) + 64;
      const results = []; // por janela: o melhor (pessoa, gravador)
      const peakSets = []; // por janela × pessoa × gravador: os maiores picos (consenso entre janelas)
      const allSeries = []; // para a boca escolher entre os estalos
      function decideMouth() {
        // decide por gravador (os D só se comparam dentro do mesmo gravador)
        let decision = null;
        for (const key of new Set(results.map((r) => r.target))) {
          const d = VM.decide(results.filter((r) => r.target === key), info.fps);
          const rank = (x) => (x.level === "synced" ? 1000 : 0) + x.windows * 10 + x.ratio;
          if (d && (!decision || rank(d) > rank(decision))) decision = Object.assign(d, { target: key, via: "boca" });
        }
        // sem Lavanda: janelas fracas que caem no MESMO quadro (mesmo gravador) — o acerto que a razão < 1,35
        // descartava (podcast 15/10: CAM 1 nada → 2 janelas a 1 q; teste do acaso: 0% Lavanda falsa)
        if (!decision || decision.level !== "synced") {
          let cons = null;
          for (const key of new Set(peakSets.map((x) => x.key))) {
            const c = VM.consensus(peakSets.filter((x) => x.key === key), info.fps);
            if (c && (!cons || c.k > cons.k || (c.k === cons.k && c.zs > cons.zs))) cons = Object.assign(c, { target: key });
          }
          const d = VM.withConsensus(decision, cons, results, info.fps);
          if (d && d !== decision) decision = Object.assign(d, { via: "boca" });
        }
        return decision;
      }
      for (let w = 0; w < windows.length; w++) {
        if (signal.cancelled) throw new Error("cancelado");
        const win = windows[w];
        const base = 0.5 + (0.5 * w) / windows.length;
        const nExp = Math.round((win.end - win.start) * info.fps);
        prog(base, `comparando a boca com o gravador (${w + 1}/${windows.length})`);
        const fr = await mouthSeries(cam.file, info, people, { ss: win.start, t: win.end - win.start }, signal, (n) => prog(base + (0.5 / windows.length) * Math.min(1, n / nExp), `comparando a boca com o gravador (${w + 1}/${windows.length})`), a.lane);
        if (!fr.length) continue;
        const tFirst = fr[0].t;
        const n = Math.round((fr[fr.length - 1].t - tFirst) * info.fps) + 1;
        let best = null;
        for (let p = 0; p < people.length; p++) {
          const series = new Float32Array(n).fill(NaN);
          for (const x of fr) { const i = Math.round((x.t - tFirst) * info.fps); if (i >= 0 && i < n && x.open[p] != null) series[i] = x.open[p]; }
          for (const tg of tlist) {
            const T = targetFor(tg.key, tg.feat, info.fps, Math.max(maxFrames, n + 64));
            // série maior que a gravação não tem encaixe: fica o miolo (≤ 75% da gravação)
            let sr = series, st = tFirst;
            const cap = Math.floor(T.len * 0.75);
            if (n > cap) {
              if (cap < 60) continue;
              const off = Math.floor((n - cap) / 2);
              sr = series.subarray(off, off + cap);
              st = tFirst + off / info.fps;
            }
            allSeries.push({ series: sr, tFirst: st, key: tg.key });
            const r = VM.matchWindow(sr, st, T, info.fps);
            if (r) peakSets.push({ w, key: tg.key, len: r.len, peaks: r.peaks });
            if (r && (!best || r.ratio > best.ratio)) best = Object.assign(r, { person: p, target: tg.key });
          }
        }
        if (best) results.push(best);
        // normal: o 1º trecho já deu Lavanda → não precisa do 2º
        if (!a.deep && w === 0 && windows.length > 1) {
          const d0 = decideMouth();
          if (d0 && d0.level === "synced") break;
        }
      }
      let decision = decideMouth();
      // tomada curta: a série da boca cabe com pouca folga (tomada de 36 s → ~9 s de posições), e a
      // razão pico/2º perde o sentido — MVI_0277 virou Lavanda 6,6 s fora (14/10). Só Pêssego.
      const takeDur = takeMode ? tlist[0].feat.durationSec || 0 : Infinity;
      if (decision && decision.via === "boca" && takeDur < 60) decision.level = "review";
      let confirm = null;
      if (cands.length) {
        // a boca confirmou um dos estalos (pico dela a até 0,25 s) → posição da claquete
        let pick = decision ? cands.find((c) => c.target === decision.target && Math.abs(c.D - decision.D) <= 0.25) : null;
        // a boca achou posição própria longe de todo estalo → fica a boca, como na 2.5.1. Antes a claquete
        // a substituía: numa palestra sem claquete o detector "viu" batidas aos 3 e 14 s (medido 14/10)
        if (!pick && !decision) {
          // sem pico claro da boca: vários estalos → compara a correlação só nas posições deles;
          // um só → a correlação perto dele tem que ser o pico da gravação (confirmByMouth)
          let best = null;
          for (const key of new Set(cands.map((c) => c.target))) {
            const tc = cands.filter((c) => c.target === key);
            const tg = tlist.find((t) => t.key === key);
            for (const s of allSeries.filter((x) => x.key === key)) {
              const T = targetFor(key, tg.feat, info.fps, Math.max(maxFrames, s.series.length + 64));
              const corr = VM.xcorrNorm(VM.highpass(s.series, VM.DEFAULTS.hp), T);
              if (tc.length > 1) {
                const r = CL.pickByMouth(corr, s.tFirst, info.fps, tc.map((c) => c.D));
                if (r && (!best || r.r * r.lead > best.score)) best = { c: tc[r.i], score: r.r * r.lead };
              } else {
                const r = CL.confirmByMouth(corr, s.tFirst, info.fps, tc[0].D);
                if (r && (!confirm || r.r * r.lead > confirm.r * confirm.lead)) confirm = r; // registro, para calibrar
                if (r && r.ok && (!best || r.r * r.lead > best.score)) best = { c: tc[0], score: r.r * r.lead };
              }
            }
          }
          pick = best && best.c;
        }
        if (pick) decision = clapDecision(pick, "synced");
        else if (!decision) decision = fallback();
      }
      return { decision, reason: decision ? "" : "boca não bateu com o gravador", clap: clap || (cands[0] ? { t: cands[0].t } : null), confirm, people, windows: results, info, ms: Date.now() - t0 };
    }

    return { ffmpeg: ff, analyzeFile, findPeople, duration, close: () => pool.close(), pool };
  }

  /** Disponibilidade (para a interface), sem criar workers. */
  function available() {
    const f = FF.find();
    return f.ok ? { ok: true, version: f.version, exe: f.exe } : { ok: false, reason: f.reason };
  }

  root.AESyncVisual = { create, available };
})(window);
