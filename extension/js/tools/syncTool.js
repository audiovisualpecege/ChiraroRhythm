/**
 * syncTool.js — aba "Sincronizar" (estilo PluralEyes, dentro da timeline).
 *
 * 1 faixa = 1 aparelho. Lê o áudio de todos os arquivos, acha quem gravou o
 * mesmo som (syncMatch), monta a corrente cronológica (syncPlan) e cria uma
 * CÓPIA da sequência com os clipes no lugar — a original não é tocada.
 * Nenhum clipe muda de faixa; o vídeo e o áudio vinculado andam juntos.
 */
(function (root) {
  const { $, setStatus, formatDuration, formatTimecode, confirmDialog, escapeHtml, TICKS_PER_SECOND } = AEUI;
  const pathMod = require("path");
  const fs = require("fs");

  const COLORS = { synced: "#8C4EDB", review: "#FACE95", orphan: "#5E5672", noAudio: "#2C2540", lane: "rgba(255,255,255,0.04)", text: "#B9B1CC" };

  function mount(app) {
    const els = {
      tracks: $("syDevices"),
      tracksHint: $("syDevicesHint"),
      summary: $("sySummary"),
      result: $("syResult"),
      canvas: $("syMap"),
      mapWrap: $("syMapWrap"),
      tooltip: $("syTooltip"),
      filter: $("syFilter"),
      list: $("syList"),
      notice: $("syNotice"),
      progress: $("syProgress"),
      progressBar: $("syProgressBar"),
      analyze: $("syAnalyze"),
      create: $("syCreate"),
      status: $("syStatus"),
      joinGap: $("syJoinGap"),
      gapRatio: $("syGapRatio"),
      clearCache: $("syClearCache"),
      visual: $("syVisual"),
      visualHint: $("syVisualHint"),
      deep: $("syDeep"),
    };
    const VISUAL_HINT = els.visualHint.textContent;

    // espaçamento entre grupos (tempo real comprimido) — lembrado entre sessões
    const prefs = AEStore.loadPrefs("sync", { joinGapSec: 30, gapRatio: 15 });
    els.joinGap.value = prefs.joinGapSec;
    els.gapRatio.value = prefs.gapRatio;
    const respace = AEUI.debounce(async () => {
      if (!state.plan || state.busy) return;
      setBusy(true);
      setStatus(els.status, "Recalculando o espaçamento…");
      try {
        await replan(null);
        setStatus(els.status, "Espaçamento atualizado.", "success");
      } catch (err) {
        setStatus(els.status, err.message, "error");
      } finally {
        setBusy(false);
      }
    }, 400);
    AEUI.bindNumber(els.joinGap, (v) => { prefs.joinGapSec = v; AEStore.savePrefs("sync", prefs); respace(); });
    AEUI.bindNumber(els.gapRatio, (v) => { prefs.gapRatio = v; AEStore.savePrefs("sync", prefs); respace(); });

    const state = {
      sig: null, // assinatura da sequência (id + clipes por faixa) usada nos aparelhos
      info: null, // resposta de syncInfo
      devices: [],
      unchecked: new Set(), // aparelhos desmarcados (por id) — vale enquanto a sequência for a mesma
      feats: new Map(), // caminho -> feat | { error } (fica enquanto o painel estiver aberto)
      busy: false,
      cancel: false,
      items: null, // itens analisados
      fm: null, // casamentos
      plan: null,
      forced: new Set(), // clipes mandados para órfão
      filter: "review",
      created: null, // { id, name } da cópia criada a partir deste plano
      analyzedSig: null,
      // sincronização por imagem: SEMPRE começa desligada (não é lembrada — decisão do usuário)
      visual: false,
      visualMatches: [], // casamentos câmera ↔ gravador vindos da boca
      visualRes: new Map(), // faixa|arquivo -> resultado do motor (motivo quando não achou)
      engine: null,
    };

    // ------------------------------------------------------------ aparelhos
    function signature(info) {
      if (!info || !info.sequence) return null;
      const v = (info.videoTracksInfo || []).map((t) => t.clips + (t.locked ? "L" : "")).join(",");
      const a = (info.audioTracks || []).map((t) => t.clips + (t.locked ? "L" : "")).join(",");
      return `${info.sequence.id}|${v}|${a}`;
    }

    function normPath(p) {
      return p ? pathMod.normalize(String(p)) : "";
    }

    const buildDevices = AESyncSetup.buildDevices;

    function renderDevices() {
      if (!state.devices.length) {
        els.tracks.innerHTML = "";
        els.tracksHint.textContent = state.info ? "Nenhuma faixa com clipes nesta sequência." : "Abra uma sequência na Timeline.";
        return;
      }
      els.tracks.innerHTML = state.devices
        .map((d) => {
          const usable = AESyncSetup.usable(d, state.visual);
          const on = usable && !state.unchecked.has(d.id);
          const note = d.locked ? d.lockNote : d.graphicsOnly ? "só gráficos" : !d.withAudio ? (state.visual && d.video ? "só imagem" : "sem áudio") : "";
          return `<label class="track-chip device-chip${on ? " track-chip--on" : ""}${usable ? "" : " track-chip--empty"}" title="${escapeHtml(note || "Aparelho incluído na sincronização")}">
            <input type="checkbox" data-dev="${d.id}"${on ? " checked" : ""}${usable ? "" : " disabled"} />
            <span class="device-name">${escapeHtml(d.label)}</span>
            <span class="tag">${d.clips.length} clipe${d.clips.length === 1 ? "" : "s"} · ${formatDuration(d.seconds)}${note ? " · " + escapeHtml(note) : ""}</span>
          </label>`;
        })
        .join("");
      els.tracksHint.textContent = "Cada faixa é um aparelho (câmera ou gravador). Faixa desmarcada não se move.";
    }

    els.tracks.addEventListener("change", (e) => {
      const id = e.target.dataset && e.target.dataset.dev;
      if (!id) return;
      if (e.target.checked) state.unchecked.delete(id);
      else state.unchecked.add(id);
      renderDevices();
      invalidate("As faixas mudaram — analise de novo.");
    });

    let loadingDevices = null;
    async function loadDevices(force) {
      const info = app.info;
      const sig = signature(info);
      if (!sig) {
        state.sig = null;
        state.info = null;
        state.devices = [];
        renderDevices();
        refreshButtons();
        return;
      }
      if (!force && sig === state.sig) return;
      if (loadingDevices) return loadingDevices;
      loadingDevices = (async () => {
        try {
          const si = await AEHost.call("syncInfo", { seqId: info.sequence.id });
          if (state.sig && state.sig.split("|")[0] !== sig.split("|")[0]) state.unchecked.clear();
          state.sig = sig;
          state.info = si;
          state.devices = buildDevices(si);
          renderDevices();
          if (state.plan && state.analyzedSig !== sig) invalidate("A sequência mudou desde a análise — analise de novo.");
        } catch (err) {
          setStatus(els.status, err.message, "error");
        } finally {
          loadingDevices = null;
          refreshButtons();
        }
      })();
      return loadingDevices;
    }

    // ------------------------------------------------------------ análise
    function setBusy(b) {
      state.busy = b;
      els.progress.hidden = !b;
      if (!b) els.progressBar.style.width = "0";
      els.analyze.textContent = b ? "Cancelar" : "Analisar";
      els.analyze.classList.toggle("btn--danger-ghost", b);
      els.tracks.querySelectorAll("input").forEach((i) => (i.disabled = b || i.closest(".track-chip--empty") != null));
      refreshButtons();
      refreshCacheInfo();
    }
    function progress(frac) {
      els.progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    }

    function selectedDevices() {
      return state.devices.filter((d) => AESyncSetup.usable(d, state.visual) && !state.unchecked.has(d.id));
    }

    /** Itens do plano: um por clipe dos aparelhos marcados, na ordem da faixa. */
    const buildItems = () => AESyncSetup.buildItems(state.devices, state.unchecked, normPath, state.visual);

    // ------------------------------------------------------------ leitura do áudio
    // ordem: memória do painel → cache em disco → workers (vários núcleos) → thread principal
    const CACHE_MAX = 3 * 1024 * 1024 * 1024;
    const cacheDir = () => pathMod.join(AEStore.dataDir(), "cache");
    let pool = null;
    function getPool() {
      if (pool) return pool;
      let file = null;
      try {
        // caminho do painel no disco (file:///C:/.../index.html) -> js/sync/syncWorker.js
        let p = decodeURIComponent(window.location.pathname);
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
        file = pathMod.join(pathMod.dirname(p), "js", "sync", "syncWorker.js");
        if (!fs.existsSync(file)) file = null;
      } catch (e) { file = null; }
      pool = AESyncPool.create({ workerFile: file, max: 10 });
      return pool;
    }

    async function readFeatures(items, report) {
      const paths = [...new Set(items.filter((it) => !it.noAudio).map((it) => it.path))];
      const todo = paths.filter((p) => !state.feats.has(p));
      const size = new Map(todo.map((p) => { let s = 1; try { s = fs.statSync(p).size; } catch (e) {} return [p, s]; }));
      const total = todo.reduce((s, p) => s + size.get(p), 0) || 1;
      let done = 0, n = 0, fromCache = 0;
      const t0 = Date.now();
      const dir = cacheDir();
      const pl = getPool();
      const finish = (p, f) => {
        state.feats.set(p, f);
        done += size.get(p);
        n++;
        report(done / total, `Lendo áudio ${n}/${todo.length}${fromCache ? ` (${fromCache} do cache)` : ""}${pl.parallel ? ` · ${pl.size} núcleos` : ""}`, t0);
      };
      const needMain = [];
      await Promise.all(todo.map(async (p) => {
        if (state.cancel) return;
        const cached = AESyncCache.load(dir, p);
        if (cached) { fromCache++; finish(p, cached); return; }
        try {
          const f = await pl.analyze(p);
          if (!f) { needMain.push(p); return; } // sem worker ou formato que só o painel decodifica
          AESyncCache.save(dir, p, f);
          finish(p, f);
        } catch (err) {
          // falha no worker: tenta de novo na thread principal (lá o erro, se houver, é o real)
          needMain.push(p);
        }
      }));
      // o que precisa da thread principal (sem workers, ou AAC/MP3 pelo decodificador do Chromium)
      for (const p of needMain) {
        if (state.cancel) throw new Error("cancelado");
        try {
          const base = done;
          const f = await AESyncAudio.analyzeFile(p, {
            decode: AEDecode.decode,
            isCancelled: () => state.cancel,
            onProgress: (fr) => report((base + fr * size.get(p)) / total, `Lendo áudio ${n + 1}/${todo.length} · ${pathMod.basename(p)}`, t0),
          });
          if (f.clock == null) {
            const rec = AESyncClock.recordedAt(p);
            f.clock = rec ? rec.t : null;
          }
          AESyncCache.save(dir, p, f);
          finish(p, f);
        } catch (err) {
          if (err.message === "cancelado") throw err;
          finish(p, { error: err.message });
        }
      }
      if (state.cancel) throw new Error("cancelado");
      AESyncCache.prune(dir, CACHE_MAX);
      refreshCacheInfo();
      // ilegíveis viram órfãos com o motivo; relógio de cada clipe (para o espaçamento)
      const clockCache = new Map();
      for (const it of items) {
        const f = state.feats.get(it.path);
        if (f && f.error) {
          const ext = pathMod.extname(it.path).toUpperCase().replace(".", "");
          it.noAudio = /não suportado|not supported|Formato/i.test(f.error) && ext ? `não lido: ${ext}` : "não lido: " + f.error;
          it.path = "#" + it.id;
        }
        if (f && !f.error) it.clock = f.clock;
        else if (it.mediaPath) {
          // sem áudio (ex.: vídeo sem som vinculado): o relógio ainda serve para o lugar dele
          if (!clockCache.has(it.mediaPath)) { const r = AESyncClock.recordedAt(it.mediaPath); clockCache.set(it.mediaPath, r ? r.t : null); }
          it.clock = clockCache.get(it.mediaPath);
        }
      }
    }

    /** Diagnóstico: uma linha por análise/criação em %APPDATA%\AutomacaoEdicao\sync-log.txt (guarda as últimas ~200). */
    function writeLog(line) {
      try {
        const file = pathMod.join(AEStore.dataDir(), "sync-log.txt");
        let old = "";
        try { old = fs.readFileSync(file, "utf8"); } catch (e) {}
        const lines = old.split("\n").filter(Boolean).slice(-199);
        let ver = "?";
        try {
          let p = decodeURIComponent(window.location.pathname);
          if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
          const mf = fs.readFileSync(pathMod.join(pathMod.dirname(p), "CSXS", "manifest.xml"), "utf8");
          ver = (/ExtensionBundleVersion="([^"]+)"/.exec(mf) || [])[1] || "?";
        } catch (e) {}
        lines.push(`${new Date().toLocaleString("pt-BR")} · v${ver} · ${line}`);
        fs.mkdirSync(pathMod.dirname(file), { recursive: true });
        fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
      } catch (e) { /* log é só diagnóstico */ }
    }

    function refreshCacheInfo() {
      let mb = 0;
      try { mb = AESyncCache.sizeOf(cacheDir()) / 1048576; } catch (e) {}
      els.clearCache.textContent = `Limpar cache${mb >= 1 ? ` (${mb >= 1024 ? (mb / 1024).toFixed(1).replace(".", ",") + " GB" : Math.round(mb) + " MB"})` : ""}`;
      els.clearCache.disabled = mb < 0.01 || state.busy;
    }

    async function analyze() {
      if (state.busy) {
        state.cancel = true;
        return;
      }
      await loadDevices(true);
      const si = state.info;
      if (!si || !selectedDevices().length) {
        setStatus(els.status, "Marque ao menos uma faixa com áudio.", "error");
        return;
      }
      if (selectedDevices().length < 2) {
        setStatus(els.status, "Sincronizar precisa de pelo menos 2 aparelhos (faixas).", "error");
        return;
      }
      if (!selectedDevices().some((d) => d.withAudio > 0)) {
        setStatus(els.status, "Nenhuma faixa marcada tem áudio — a imagem precisa do som de um gravador para comparar.", "error");
        return;
      }
      state.cancel = false;
      state.created = null;
      setBusy(true);
      const tStart = Date.now();
      // pesos das etapas na barra: leitura 0–0,6 · comparação 0,6–0,8 · corrente 0,8–1
      const report = (stageFrom, stageTo) => (frac, label, t0) => {
        const f = stageFrom + (stageTo - stageFrom) * Math.max(0, Math.min(1, frac));
        progress(f);
        let eta = "";
        const el = (Date.now() - tStart) / 1000;
        if (f > 0.05 && el > 3) eta = ` · falta ~${formatDuration(Math.max(1, (el / f) * (1 - f)))}`;
        setStatus(els.status, (label || "") + eta);
        void t0;
      };
      const stages = [];
      const mark = (name, t) => stages.push(`${name} ${((Date.now() - t) / 1000).toFixed(1)} s`);
      // com imagem: leitura 0–0,3 · comparação 0,3–0,4 · corrente 0,4–0,45 · imagem 0,45–0,95 · corrente 0,95–1
      const W = state.visual ? [0, 0.3, 0.4, 0.45] : [0, 0.6, 0.8, 1];
      try {
        const items = buildItems();
        let t = Date.now();
        const pl = getPool();
        await readFeatures(items, report(W[0], W[1]));
        mark("leitura", t);
        const clips = items.filter((it) => !it.noAudio).map((it) => ({ id: it.id, track: it.track, media: it.path }));
        const rMatch = report(W[1], W[2]);
        t = Date.now();
        const fm = await AESyncMatch.findMatches(clips, state.feats, {
          isCancelled: () => state.cancel,
          onProgress: (f) => rMatch(f, "Comparando os áudios…"),
          runner: pl.runner,
          voter: pl.voter,
        });
        mark("comparação", t);
        state.items = items;
        state.fm = fm;
        state.forced = new Set();
        state.visualMatches = [];
        state.visualRes = new Map();
        t = Date.now();
        await replan(report(W[2], W[3]));
        mark("plano", t);
        let vis = "";
        if (state.visual) {
          t = Date.now();
          const v = await runVisual(false, report(0.45, 0.95));
          mark("imagem", t);
          if (v.n) {
            t = Date.now();
            await replan(report(0.95, 1));
            mark("plano 2", t);
          }
          vis = ` · imagem: ${v.ok}/${v.n} arquivo(s) de câmera casados pela imagem${v.approx ? ` · ${v.approx} só aproximado(s) pela tomada` : ""}`;
        }
        state.analyzedSig = state.sig;
        const secs = (Date.now() - tStart) / 1000;
        const cores = pl.parallel ? `${pl.size} núcleos` : `sem núcleos extras (${pl.reason || "?"})`;
        writeLog(`análise ${formatDuration(secs)} · ${cores} · ${stages.join(" · ")} · ${items.length} clipes · ${state.plan.placed.filter((p) => p.synced).length} sincronizados${vis}`);
        setStatus(els.status, `Análise pronta em ${formatDuration(secs)} (${cores}${vis}). Revise a lista e clique em Criar sequência sincronizada.`, "success");
      } catch (err) {
        if (err.message === "cancelado") setStatus(els.status, "Análise cancelada.");
        else setStatus(els.status, "Erro na análise: " + err.message, "error");
      } finally {
        setBusy(false);
      }
    }

    async function replan(rep) {
      const fps = TICKS_PER_SECOND / state.info.timebase;
      // casamentos da imagem entram junto com os do áudio (qualidade menor: o áudio tem prioridade)
      const fm = state.visualMatches.length ? Object.assign({}, state.fm, { matches: state.fm.matches.concat(state.visualMatches) }) : state.fm;
      const plan = await AESyncPlan.buildPlan(state.items, fm, {
        fps,
        forcedOrphans: [...state.forced],
        joinGapSec: prefs.joinGapSec,
        gapRatio: prefs.gapRatio / 100,
        maxGapSec: 600,
        isCancelled: () => state.cancel,
        onProgress: (f) => rep && rep(f, "Montando a corrente cronológica…"),
      });
      state.plan = plan;
      state.created = null;
      renderResult();
      refreshButtons();
    }

    // ------------------------------------------------------------ imagem (boca × voz)
    // Etapa separada: só os clipes de câmera que o áudio não resolveu (ou, no
    // "a fundo", também os que a boca deixou para revisar).
    const NO_VISUAL = /imagem|gráfico|aninhada|velocidade|invertido|sem arquivo/;
    const vKey = (track, file) => track + "|" + file;
    // posição veio da imagem (claquete ou boca)
    const byImage = (p) => p.synced && !!p.via && p.via !== "áudio";

    function visualCandidates(deep) {
      const out = new Map();
      state.items.forEach((it, i) => {
        const p = state.plan.placed[i];
        if (!it.track.startsWith("V") || !it.mediaPath || NO_VISUAL.test(it.noAudio || "")) return;
        if (state.forced.has(it.id)) return;
        if (p.synced && !(deep && byImage(p) && p.review)) return;
        const k = vKey(it.track, it.mediaPath);
        if (!out.has(k)) out.set(k, { track: it.track, file: it.mediaPath, items: [] });
        out.get(k).items.push(it);
      });
      return [...out.values()];
    }

    const featOk = (it) => !it.noAudio && state.feats.get(it.path) && !state.feats.get(it.path).error && state.feats.get(it.path).env;
    /** Áudio de gravador = arquivo que não está em nenhuma faixa de vídeo (o áudio da própria câmera não serve de referência). */
    function recorderItems() {
      const camFiles = new Set(state.items.filter((it) => it.track.startsWith("V")).map((it) => it.path));
      return state.items.filter((it) => it.track.startsWith("A") && featOk(it) && !camFiles.has(it.path));
    }

    /**
     * Qual tomada (arquivo do gravador) é de cada arquivo de câmera: cada aparelho
     * numa faixa, na ordem de gravação (decisão do usuário 13/10) → alinhamento
     * por ordem e duração (AESyncClap.alignTakes). Vários gravadores: fica o que
     * alinha melhor com aquela câmera. Devolve Map(vKey → caminho do gravador).
     */
    function takePairing() {
      const out = new Map();
      const ordered = (track, pick) => {
        const seen = new Set();
        return state.items
          .filter((it) => it.track === track && pick(it))
          .sort((a, b) => a.start - b.start)
          .filter((it) => (seen.has(it.path) ? false : (seen.add(it.path), true)));
      };
      const recs = recorderItems();
      const recTracks = [...new Set(recs.map((it) => it.track))];
      const recSet = new Set(recs.map((it) => it.id));
      const camTracks = [...new Set(state.items.filter((it) => it.track.startsWith("V") && it.mediaPath).map((it) => it.track))];
      const summary = [];
      for (const ct of camTracks) {
        const cams = ordered(ct, (it) => !!it.mediaPath && !NO_VISUAL.test(it.noAudio || ""));
        const camDurs = cams.map((it) => state.engine.duration(it.mediaPath) || 0);
        let best = null;
        for (const rt of recTracks) {
          const takes = ordered(rt, (it) => recSet.has(it.id));
          const al = AESyncClap.alignTakes(camDurs, takes.map((it) => state.feats.get(it.path).durationSec || 0));
          if (!best || al.score > best.al.score) best = { al, takes, rt };
        }
        if (!best) continue;
        let n = 0;
        cams.forEach((it, i) => {
          const j = best.al.take[i];
          if (j >= 0) { out.set(vKey(ct, it.mediaPath), best.takes[j].path); n++; }
        });
        summary.push(`${ct}↔${best.rt} ${n}/${cams.length}`);
      }
      writeLog(`imagem: tomadas por ordem e duração · ${summary.join(" · ") || "nenhuma"}`);
      return out;
    }

    /** Gravadores: faixas só de áudio com som lido; sem nenhuma, qualquer outro aparelho com som. */
    function visualTargets(camTrack) {
      const ok = featOk;
      let list = recorderItems();
      if (!list.length) list = state.items.filter((it) => it.track !== camTrack && ok(it));
      const seen = new Map();
      for (const it of list) if (!seen.has(it.path)) seen.set(it.path, it);
      return [...seen.values()].map((it) => ({ key: it.path, feat: state.feats.get(it.path), item: it }));
    }

    async function runVisual(deep, rep) {
      const cands = visualCandidates(deep);
      if (!cands.length) return { n: 0, ok: 0 };
      if (!state.engine) state.engine = AESyncVisual.create({});
      const signal = { get cancelled() { return state.cancel; } };
      // Tomadas só existem com VÁRIOS arquivos numa faixa de gravador (material da claquete). Com um
      // gravador contínuo (palestra) o casamento por ordem "achava" 1/1 e a boca passava a olhar só os
      // 3 primeiros min → regressão medida 14/10 (2.5.1: 3/3 certas; 2.7.4: 2 a 19 q). Sem tomadas = 2.5.1.
      const recs = recorderItems();
      const multiTake = [...new Set(recs.map((it) => it.track))].some((tr) => new Set(recs.filter((it) => it.track === tr).map((it) => it.path)).size > 1);
      rep(0, multiTake ? "Imagem · casando arquivos e tomadas pela ordem…" : "Imagem · gravador contínuo");
      const takes = multiTake ? takePairing() : new Map();
      if (!multiTake) writeLog("imagem: gravador contínuo (1 arquivo por faixa) · sem tomadas");
      let done = 0, ok = 0, approx = 0;
      // 2 arquivos ao mesmo tempo: o ffmpeg do HEVC 4K não ocupa o processador todo (1,36× medido 14/10)
      const queue = cands.slice();
      const running = new Map(); // arquivo → fração
      const progress2 = () => {
        let f = done;
        for (const v of running.values()) f += v;
        return f / cands.length;
      };
      // cada arquivo usa metade dos workers de rosto (o rastreio não mistura dois vídeos)
      const half = Math.max(1, Math.floor(state.engine.pool.size / 2));
      const lanes = [{ from: 0, count: half }, { from: half, count: state.engine.pool.size - half }];
      const worker = async (lane) => {
        while (queue.length) {
          if (state.cancel) throw new Error("cancelado");
          await one(queue.shift(), lane);
        }
      };
      await Promise.all(lanes[1].count > 0 ? [worker(lanes[0]), worker(lanes[1])] : [worker(null)]);
      // Tomada conhecida mas sem claquete e sem boca: em vez de órfão (que encosta nos vizinhos e
      // pode ir parar dezenas de segundos longe — CHIARO4729, 14/10), entra NA tomada, começando junto
      // com o gravador. Medido no gabarito: erro mediano 1,6 s, p90 5,6 s (a mediana das outras câmeras
      // da tomada não foi melhor: 1,5 / 7,1 s). Sempre Pêssego.
      for (const c of cands) {
        const key = vKey(c.track, c.file), take = takes.get(key);
        const r = state.visualRes.get(key);
        if (!take || !r || r.decision) continue;
        const targets = visualTargets(c.track);
        if (!targets.some((t) => t.key === take)) continue;
        const D = 0;
        r.decision = { D, ratio: 1, windows: 0, agree: false, level: "review", via: "tomada", target: take };
        r.note = "posição aproximada pela tomada (começa junto do gravador)";
        pushMatches(c, key, r, targets);
        writeLog(`imagem ${pathMod.basename(c.file)} (tomada ${pathMod.basename(take)}): ${r.note} · D ${D.toFixed(3)}`);
      }
      return { n: cands.length, ok, approx };

      function pushMatches(c, key, r, targets) {
        state.visualMatches = state.visualMatches.filter((m) => m._vkey !== key);
        if (!r.decision) return;
        // a posição aproximada pela tomada não é sincronização: conta à parte
        if (r.decision.via === "tomada") approx++;
        else ok++;
        const tg = targets.find((t) => t.key === r.decision.target);
        const srcs = new Set();
        for (const it of c.items) {
          const sk = it.track + "|" + it.path;
          if (srcs.has(sk)) continue;
          srcs.add(sk);
          // offset = tempo na câmera − tempo no gravador (convenção do AESyncMatch)
          state.visualMatches.push({
            _vkey: key, visual: r.decision.via || "boca",
            a: { track: it.track, media: it.path }, b: { track: tg.item.track, media: tg.item.path },
            offset: -r.decision.D, quality: 0.5 * r.decision.ratio, sharp: r.decision.ratio,
            precise: true, weak: false, review: r.decision.level !== "synced", votes: 0, driftSec: 0,
          });
        }
      }

      async function one(c, lane) {
        const key = vKey(c.track, c.file);
        const targets = visualTargets(c.track);
        let r;
        if (!targets.length) r = { decision: null, reason: "nenhum gravador com som lido" };
        else {
          try {
            running.set(key, 0);
            r = await state.engine.analyzeFile({ file: c.file }, targets, {
              deep,
              take: takes.get(key) || null,
              lane,
              signal,
              onProgress: (f, label) => {
                running.set(key, f);
                rep(progress2(), `Imagem ${done + 1}/${cands.length} · ${pathMod.basename(c.file)} · ${label}${state.engine ? ` · ${state.engine.pool.size} núcleos` : ""}`);
              },
            });
          } catch (err) {
            running.delete(key);
            if (err.message === "cancelado") throw err;
            r = { decision: null, reason: err.message };
          }
          running.delete(key);
          // várias tomadas e este arquivo não casou com nenhuma pela ordem: a imagem no máximo sugere
          if (multiTake && r.decision && !takes.get(key) && new Set(targets.map((t) => t.key)).size > 1) r.decision.level = "review";
        }
        // no "a fundo" um resultado pior não apaga o que já havia
        const prev = state.visualRes.get(key);
        if (!(deep && prev && prev.decision && !r.decision)) {
          state.visualRes.set(key, r);
          pushMatches(c, key, r, targets);
        }
        writeLog(`imagem ${pathMod.basename(c.file)}${takes.get(key) ? ` (tomada ${pathMod.basename(takes.get(key))})` : " (sem tomada)"}: ${r.clap ? `claquete em ${r.clap.t.toFixed(3)} s · ` : ""}${r.decision ? `${r.decision.via || "boca"} · ${r.decision.level} · D ${r.decision.D.toFixed(3)} · razão ${r.decision.ratio.toFixed(2)} · ${r.decision.windows} trecho(s)${r.decision.consensus ? " em consenso" : ""}` : r.reason} ${r.confirm ? ` · confirmação boca r ${r.confirm.r.toFixed(3)} × ${r.confirm.lead.toFixed(2)}` : ""}${r.motion ? ` · movimento ${r.motion.raw.toFixed(2)}` : ""}${r.note ? ` · ${r.note}` : ""} · ${r.people ? r.people.length : 0} pessoa(s) · ${((r.ms || 0) / 1000).toFixed(1)} s${deep ? " · a fundo" : ""}`);
        done++;
      }
    }

    async function deepVisual() {
      if (state.busy || !state.plan || !state.visual) return;
      state.cancel = false;
      setBusy(true);
      const tStart = Date.now();
      const rep = (frac, label) => {
        progress(frac);
        const el = (Date.now() - tStart) / 1000;
        setStatus(els.status, label + (frac > 0.05 && el > 3 ? ` · falta ~${formatDuration(Math.max(1, (el / frac) * (1 - frac)))}` : ""));
      };
      try {
        const v = await runVisual(true, (f, l) => rep(0.95 * f, l));
        if (!v.n) { setStatus(els.status, "Nada para analisar a fundo: nenhuma câmera órfã ou a revisar."); return; }
        await replan(null);
        setStatus(els.status, `Análise a fundo pronta em ${formatDuration((Date.now() - tStart) / 1000)}: ${v.ok}/${v.n} arquivo(s) casados pela imagem${v.approx ? ` · ${v.approx} só aproximado(s) pela tomada` : ""}.`, "success");
      } catch (err) {
        if (err.message === "cancelado") setStatus(els.status, "Análise a fundo cancelada.");
        else setStatus(els.status, "Erro na análise pela imagem: " + err.message, "error");
      } finally {
        setBusy(false);
      }
    }

    els.visual.addEventListener("change", () => {
      if (els.visual.checked) {
        const av = AESyncVisual.available();
        if (!av.ok) {
          els.visual.checked = false;
          els.visualHint.textContent = `Indisponível: ${av.reason}. O instalador do Rhythm (.exe) instala o ffmpeg; se você instalou só pelo .zxp, rode o instalador.`;
          els.visualHint.classList.add("hint--error");
          return;
        }
        els.visualHint.textContent = VISUAL_HINT + ` (ffmpeg ${av.version})`;
      } else els.visualHint.textContent = VISUAL_HINT;
      els.visualHint.classList.remove("hint--error");
      state.visual = els.visual.checked;
      renderDevices();
      invalidate("A sincronização por imagem mudou — analise de novo.");
      refreshButtons();
    });
    els.deep.addEventListener("click", deepVisual);

    // ------------------------------------------------------------ resultado
    const byItemId = () => new Map(state.items.map((it, i) => [it.id, i]));

    function statusOf(p) {
      if (p.synced) return p.review ? "review" : "synced";
      return "orphan";
    }

    function renderResult() {
      const plan = state.plan;
      els.result.hidden = !plan;
      if (!plan) {
        els.summary.innerHTML = `<li><span>Clique em <strong>Analisar</strong> para ler o áudio de todas as faixas marcadas e achar quem gravou o mesmo som.</span></li>`;
        return;
      }
      const placed = plan.placed;
      const synced = placed.filter((p) => p.synced);
      const review = synced.filter((p) => p.review).length;
      const orphans = placed.length - synced.length;
      const noAudio = state.items.filter((it) => it.noAudio).length;
      const endBefore = Math.max(...state.items.map((it) => it.end));
      const endAfter = Math.max(...placed.map((p, i) => p.start + state.items[i].end - state.items[i].start));
      els.summary.innerHTML = [
        `<li>Grupos sincronizados <b>${plan.groups.length}</b></li>`,
        `<li>Clipes sincronizados <b>${synced.length}${review ? ` (${review} a revisar)` : ""}</b></li>`,
        `<li>Órfãos (ficam no lugar, seguindo o anterior) <b>${orphans}</b></li>`,
        noAudio ? `<li>Sem áudio / não lidos <b>${noAudio}</b></li>` : "",
        `<li>Duração da sequência <b>${formatDuration(endBefore)} → ${formatDuration(endAfter)}</b></li>`,
      ].join("");

      const notes = [];
      if (plan.drift.length) notes.push(`Deriva de relógio acima de 1 quadro em ${plan.drift.length} ligação(ões) longa(s) — alinhado pelo meio.`);
      if (plan.warnings.length) notes.push(`${plan.warnings.length} trecho(s) com órfãos sem espaço entre clipes sincronizados — eles foram encostados e podem sobrepor.`);
      els.notice.hidden = !notes.length;
      els.notice.innerHTML = notes.length ? `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : "";

      // filtro padrão: revisar se houver; senão órfãos
      if (state.filter === "review" && !review) state.filter = orphans ? "orphan" : "all";
      els.filter.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === state.filter)));
      const counts = { review, orphan: orphans, synced: synced.length, all: placed.length };
      els.filter.querySelectorAll("button").forEach((b) => (b.querySelector(".count").textContent = counts[b.dataset.value]));
      renderList();
      drawMap();
    }

    function renderList() {
      const plan = state.plan;
      if (!plan) return;
      const fps = TICKS_PER_SECOND / state.info.timebase;
      const idx = byItemId();
      const rows = [];
      state.items.forEach((it, i) => {
        const p = plan.placed[i];
        const st = statusOf(p);
        const forced = state.forced.has(it.id);
        if (state.filter === "review" && st !== "review") return;
        if (state.filter === "orphan" && st !== "orphan") return;
        if (state.filter === "synced" && st === "orphan") return;
        let detail;
        if (p.synced) {
          const partner = p.partner != null ? state.items[idx.get(p.partner)] : null;
          detail = partner ? `casou com ${escapeHtml(partner.name)} (${partner.track})` : "sincronizado";
          detail = `<span class="tag tag--via">${byImage(p) ? escapeHtml(p.via) : "áudio"}</span> ` + detail;
          if (p.review) {
            const vr = byImage(p) && it.mediaPath ? state.visualRes.get(vKey(it.track, it.mediaPath)) : null;
            detail += vr && vr.note ? ` · ${escapeHtml(vr.note)}` : " · evidência fraca";
          }
        } else {
          detail = escapeHtml(it.noAudio || p.reason || "não casou");
          const vr = state.visual && it.mediaPath ? state.visualRes.get(vKey(it.track, it.mediaPath)) : null;
          if (vr && !vr.decision) detail += ` · imagem: ${escapeHtml(vr.reason || "não casou")}`;
          // órfão com relógio confiável fica no lugar pelo horário de gravação
          if (it.clock != null && !/sem relógio|relógio sem referência|horário fora de ordem|mandado/.test(p.reason || "")) detail = `<span class="tag tag--via">relógio</span> ` + detail + " · posição pelo relógio";
        }
        const canToggle = p.synced || forced;
        rows.push(`<div class="sync-row sync-row--${st}" data-i="${i}">
          <input type="checkbox" ${canToggle ? "" : "disabled"} ${p.synced ? "checked" : ""} title="${p.synced ? "Desmarque para mandar este clipe para órfão" : forced ? "Marque para voltar a sincronizar" : "Órfão"}" />
          <span class="sync-dot"></span>
          <span class="sync-name" title="${escapeHtml(it.mediaPath || it.name)}">${escapeHtml(it.name)}</span>
          <span class="sync-dev">${it.track}</span>
          <span class="sync-detail">${detail}</span>
          <button class="sync-tc mono" type="button" ${state.created ? "" : "disabled"} title="${state.created ? "Levar o cursor até este clipe na sequência sincronizada" : "Disponível depois de criar a sequência sincronizada"}">${formatTimecode(p.start, fps)}</button>
        </div>`);
      });
      els.list.innerHTML = rows.length ? rows.join("") : `<p class="hint" style="padding:10px">Nada nesta categoria.</p>`;
    }

    els.filter.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.filter = b.dataset.value;
      els.filter.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderList();
    });

    els.list.addEventListener("change", async (e) => {
      const row = e.target.closest(".sync-row");
      if (!row || e.target.type !== "checkbox" || state.busy) return;
      const it = state.items[Number(row.dataset.i)];
      if (e.target.checked) state.forced.delete(it.id);
      else state.forced.add(it.id);
      setBusy(true);
      setStatus(els.status, "Recalculando…");
      try {
        await replan(null);
        setStatus(els.status, e.target.checked ? `${it.name} voltou a ser sincronizado (se o áudio permitir).` : `${it.name} agora é órfão.`, "success");
      } catch (err) {
        setStatus(els.status, err.message, "error");
      } finally {
        setBusy(false);
      }
    });

    els.list.addEventListener("click", async (e) => {
      const b = e.target.closest(".sync-tc");
      if (!b || b.disabled || !state.created) return;
      const i = Number(b.closest(".sync-row").dataset.i);
      const p = state.plan.placed[i];
      try {
        await AEHost.call("seek", { seqId: state.created.id, ticks: Math.round(p.start * (TICKS_PER_SECOND / state.info.timebase)) * state.info.timebase });
      } catch (err) {
        setStatus(els.status, "Abra a sequência sincronizada para navegar: " + err.message, "error");
      }
    });

    // mapa: uma linha por aparelho, blocos na posição final
    let mapGeom = null;
    function drawMap() {
      const plan = state.plan;
      const cv = els.canvas;
      if (!plan) return;
      const devs = [...new Set(state.items.map((it) => it.track))];
      const dpr = window.devicePixelRatio || 1;
      const W = els.mapWrap.clientWidth || 300;
      const laneH = 14, gap = 4, labelW = 34, pad = 6;
      const H = pad * 2 + devs.length * (laneH + gap) - gap;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.height = H + "px";
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      let end = 1;
      plan.placed.forEach((p, i) => (end = Math.max(end, p.start + state.items[i].end - state.items[i].start)));
      const x0 = labelW, xw = W - labelW - pad;
      const sx = (t) => x0 + (t / end) * xw;
      ctx.font = "9px " + getComputedStyle(document.body).fontFamily;
      ctx.textBaseline = "middle";
      const boxes = [];
      devs.forEach((d, li) => {
        const y = pad + li * (laneH + gap);
        ctx.fillStyle = COLORS.lane;
        ctx.fillRect(x0, y, xw, laneH);
        ctx.fillStyle = COLORS.text;
        ctx.fillText(d, 2, y + laneH / 2);
      });
      plan.placed.forEach((p, i) => {
        const it = state.items[i];
        const li = devs.indexOf(it.track);
        const y = pad + li * (laneH + gap);
        const a = sx(p.start), b = sx(p.start + it.end - it.start);
        // sincronizado vale mais que "sem áudio": câmera muda casada pela boca mostra a força dela
        const st = p.synced ? statusOf(p) : it.noAudio ? "noAudio" : "orphan";
        const bw = Math.max(1, b - a - 0.5);
        ctx.fillStyle = COLORS[st];
        ctx.fillRect(a, y + 1, bw, laneH - 2);
        if (byImage(p)) {
          // listras diagonais = posição veio da imagem (decisão do usuário, pergunta 14)
          ctx.save();
          ctx.beginPath();
          ctx.rect(a, y + 1, bw, laneH - 2);
          ctx.clip();
          ctx.strokeStyle = "rgba(7, 0, 16, 0.45)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let x = a - laneH; x < a + bw; x += 5) { ctx.moveTo(x, y + laneH); ctx.lineTo(x + laneH, y); }
          ctx.stroke();
          ctx.restore();
        }
        boxes.push({ a, b, y, h: laneH, i });
      });
      mapGeom = boxes;
      const lv = document.getElementById("syLegendVisual");
      if (lv) lv.hidden = !plan.placed.some(byImage);
    }

    els.canvas.addEventListener("mousemove", (e) => {
      if (!mapGeom) return;
      const r = els.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = mapGeom.find((bx) => x >= bx.a - 1 && x <= bx.b + 1 && y >= bx.y && y <= bx.y + bx.h);
      if (!hit) { els.tooltip.hidden = true; return; }
      const it = state.items[hit.i];
      const p = state.plan.placed[hit.i];
      const st = statusOf(p);
      els.tooltip.textContent = `${it.name} · ${it.track} · ${st === "synced" ? "sincronizado" : st === "review" ? "revisar" : it.noAudio || "órfão"}${byImage(p) ? ` pela imagem (${p.via})` : ""}`;
      els.tooltip.hidden = false;
      els.tooltip.style.left = Math.min(r.width - 160, x + 8) + "px";
      els.tooltip.style.top = y + 10 + "px";
    });
    els.canvas.addEventListener("mouseleave", () => (els.tooltip.hidden = true));
    els.canvas.addEventListener("click", (e) => {
      if (!mapGeom) return;
      const r = els.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const hit = mapGeom.find((bx) => x >= bx.a - 1 && x <= bx.b + 1 && y >= bx.y && y <= bx.y + bx.h);
      if (!hit) return;
      state.filter = "all";
      renderResult();
      const row = els.list.querySelector(`.sync-row[data-i="${hit.i}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("sync-row--focus");
        setTimeout(() => row.classList.remove("sync-row--focus"), 1500);
      }
    });
    window.addEventListener("resize", AEUI.debounce(() => state.plan && drawMap(), 150));

    // ------------------------------------------------------------ criar a cópia
    /** Movimentos (em ticks) na cópia, em ordem segura (ver syncSetup.buildMoves). */
    const buildMoves = () => AESyncSetup.buildMoves(state.items, state.plan.placed, state.info);

    /**
     * Caminho rápido (~10 s): exporta a original como FCP XML, reescreve as
     * posições (AESyncXml) e importa como sequência nova. Erro antes da
     * importação = nada foi criado; quem chama cai em createByMoves.
     */
    async function createByXml(name, moves, expected) {
      const os = require("os");
      const stamp = Date.now();
      const src = pathMod.join(os.tmpdir(), `rhythm-sync-${stamp}-orig.xml`);
      const out = pathMod.join(os.tmpdir(), `rhythm-sync-${stamp}.xml`);
      try {
        setStatus(els.status, "Exportando a sequência…");
        progress(0.1);
        const s = (ms) => (ms / 1000).toFixed(1);
        let t = Date.now();
        await AEHost.call("syncExportXml", { seqId: state.info.seqId, path: src });
        const exportMs = Date.now() - t;
        setStatus(els.status, "Montando a sequência sincronizada…");
        progress(0.4);
        const r = AESyncXml.rewrite(fs.readFileSync(src, "utf8"), state.info, moves, { name });
        fs.writeFileSync(out, r.xml, "utf8");
        setStatus(els.status, "Importando no projeto…");
        progress(0.6);
        try {
          t = Date.now();
          const imp = await AEHost.call("syncImportXml", { path: out, name, bin: "Rhythm · Sincronizar", srcSeqId: state.info.seqId, expected });
          const callMs = Date.now() - t;
          // troca dos itens repetidos da importação em lotes curtos (o motor de
          // scripts fica livre entre eles e o progresso aparece)
          const t0 = Date.now();
          let batches = 0;
          for (;;) {
            const r = await AEHost.call("syncReplaceDuplicates", { seqId: imp.id, budgetMs: 2000 });
            batches++;
            const f = r.total ? r.processed / r.total : 1;
            progress(0.7 + 0.3 * f);
            if (r.done) {
              // tempo por etapa no log (21/10: uma criação levou 9:30 sem dizer onde)
              r.timing = `exportação ${s(exportMs)} s · importação ${s(imp.importMs != null ? imp.importMs : callMs)} s · lista ${s(imp.listMs || 0)} s · troca ${s(Date.now() - t0)} s em ${batches} lote(s)`;
              return r;
            }
            const el = (Date.now() - t0) / 1000;
            setStatus(els.status, `Trocando itens repetidos da importação ${r.processed}/${r.total}${f > 0.05 ? ` · falta ~${formatDuration(Math.max(1, (el / f) * (1 - f)))}` : ""}`);
          }
        } catch (err) {
          err.imported = true; // o Premiere pode ter importado algo: não tentar de novo pelo outro caminho
          throw err;
        }
      } finally {
        for (const f of [src, out]) try { fs.unlinkSync(f); } catch (e) {}
      }
    }

    /** Caminho antigo (lento: ~0,1 s por clipe no Premiere 26.5): duplica e move clipe a clipe. */
    async function createByMoves(name, moves, failed) {
      setStatus(els.status, "Duplicando a sequência…");
      const copy = await AEHost.call("syncClone", { seqId: state.info.seqId, name });
      const BATCH = 120;
      const t0 = Date.now();
      for (let k = 0; k < moves.length; k += BATCH) {
        const r = await AEHost.call("syncMove", { seqId: copy.id, moves: moves.slice(k, k + BATCH) });
        failed.push(...r.failed);
        const f = Math.min(1, (k + BATCH) / moves.length);
        progress(f);
        const el = (Date.now() - t0) / 1000;
        setStatus(els.status, `Movendo clipes ${Math.min(moves.length, k + BATCH)}/${moves.length}${f > 0.05 ? ` · falta ~${formatDuration(Math.max(1, (el / f) * (1 - f)))}` : ""}`);
      }
      return copy;
    }

    async function create() {
      if (!state.plan || state.busy) return;
      if (state.analyzedSig !== state.sig) {
        setStatus(els.status, "A sequência mudou desde a análise — analise de novo.", "error");
        return;
      }
      let moves;
      try {
        moves = buildMoves();
      } catch (err) {
        setStatus(els.status, err.message, "error");
        return;
      }
      const name = `${state.info.name} (Sincronizada)`;
      const synced = state.plan.placed.filter((p) => p.synced).length;
      const ok = await confirmDialog(
        "Criar sequência sincronizada",
        `Uma cópia de "${state.info.name}" será criada com ${synced} clipe(s) sincronizado(s) e os órfãos no lugar. A sequência original não é alterada. ${moves.length} clipes (vídeo e áudio) serão movidos.`,
        "Criar cópia"
      );
      if (!ok) return;
      state.cancel = false;
      setBusy(true);
      els.analyze.disabled = true;
      try {
        const failed = [];
        const tc = Date.now();
        let how = "XML";
        // onde cada clipe fica e qual item usa na origem: a troca acerta o que a importação ligou
        // errado (arquivos de mesmo nome em câmeras diferentes, 21/10) e a conferência usa
        const expected = AESyncSetup.buildExpected(state.info, moves);
        let copy = await createByXml(name, moves, expected).catch((err) => {
          if (err.imported) throw err;
          console.warn("Rhythm: criação por XML falhou, usando os movimentos —", err);
          how = `movimentos (XML falhou: ${err.message})`;
          return null;
        });
        if (!copy) copy = await createByMoves(name, moves, failed);
        // conferência: cada clipe da cópia com o mesmo item que usa na origem
        let check = null;
        try {
          await AEHost.call("syncOpen", { seqId: copy.id });
          check = AESyncSetup.checkExpected(expected, await AEHost.call("syncInfo", { seqId: copy.id }));
        } catch (eC) {
          console.warn("Rhythm: conferência da cópia falhou —", eC);
        }
        const checkInfo = check ? ` · conferência: ${check.checked} clipe(s), ${check.wrong.length} com outro item, ${check.missing} sem par` : " · conferência não rodou";
        const dupInfo = (copy.replaced != null ? ` · itens repetidos da importação: ${copy.replaced} trocado(s) pelo original, ${copy.kept} mantido(s)` : "") + (copy.timing ? ` · ${copy.timing}` : "");
        writeLog(`criação ${formatDuration((Date.now() - tc) / 1000)} por ${how} · ${moves.length} movimentos · ${failed.length} falha(s)${dupInfo}${checkInfo}`);
        state.created = copy;
        renderList();
        if (check && (check.wrong.length || check.missing)) {
          els.notice.hidden = false;
          els.notice.innerHTML = `<b>Confira a cópia: ${check.wrong.length} clipe(s) com um arquivo diferente do da original${check.missing ? ` e ${check.missing} sem par` : ""}</b><ul>${check.wrong.slice(0, 12).map((w) => `<li>${w.track} · ${escapeHtml(w.name)}</li>`).join("")}</ul>`;
          setStatus(els.status, `"${copy.name}" criada, mas a conferência achou diferenças.`, "error");
        } else if (failed.length) {
          els.notice.hidden = false;
          els.notice.innerHTML = `<b>${failed.length} clipe(s) não puderam ser movidos</b> — confira na cópia:<ul>${failed.slice(0, 12).map((f) => `<li>${f.v ? "V" : "A"}${f.t + 1} · clipe ${f.i + 1}: ${escapeHtml(f.error)}</li>`).join("")}</ul>`;
          setStatus(els.status, `"${copy.name}" criada, com ${failed.length} falha(s).`, "error");
        } else {
          if (copy.kept) {
            els.notice.hidden = false;
            els.notice.innerHTML = `<b>${copy.kept} clipe(s) ficaram com um item repetido do projeto</b> (na pasta "Rhythm · Sincronizar"): o Premiere criou uma cópia do item ao importar e o clipe tinha efeito ou vínculo, então não foi trocado pelo original.`;
          }
          setStatus(els.status, `"${copy.name}" criada e aberta. Os timecodes da lista levam até cada clipe.`, "success");
        }
      } catch (err) {
        setStatus(els.status, "Erro ao criar a cópia: " + err.message, "error");
      } finally {
        setBusy(false);
        els.analyze.disabled = false;
        app.refreshInfo();
      }
    }

    // ------------------------------------------------------------ geral
    function invalidate(msg) {
      if (!state.plan) return;
      state.plan = null;
      state.created = null;
      renderResult();
      setStatus(els.status, msg);
      refreshButtons();
    }

    function refreshButtons() {
      els.analyze.disabled = !state.busy && !(state.info && selectedDevices().length >= 2);
      els.create.disabled = state.busy || !state.plan || state.analyzedSig !== state.sig;
      const deepable = state.visual && state.plan && !state.busy && visualCandidates(true).length > 0;
      els.deep.hidden = !(state.visual && state.plan);
      els.deep.disabled = !deepable;
      els.visual.disabled = state.busy;
    }

    els.clearCache.addEventListener("click", async () => {
      if (state.busy) return;
      const ok = await confirmDialog("Limpar cache", "Apaga as leituras de áudio guardadas. A próxima análise vai ler todos os arquivos de novo (os vídeos não são tocados).", "Limpar");
      if (!ok) return;
      const n = AESyncCache.clear(cacheDir());
      state.feats.clear();
      refreshCacheInfo();
      setStatus(els.status, `Cache limpo (${n} arquivo(s)).`, "success");
    });
    els.analyze.addEventListener("click", analyze);
    els.create.addEventListener("click", create);

    renderResult();
    refreshButtons();
    refreshCacheInfo();
    window.addEventListener("beforeunload", () => { if (pool) pool.close(); if (state.engine) state.engine.close(); });
    app.syncState = state; // inspeção (prévia/testes)

    return {
      onInfo(info) {
        // syncInfo custa ~2 s numa sequência grande: só relê quando a aba está aberta e algo mudou
        if (signature(info) !== state.sig && app.active === "sync" && !state.busy) loadDevices(false);
      },
      onShow() {
        loadDevices(false);
        if (state.plan) drawMap();
      },
    };
  }

  root.AETools = root.AETools || {};
  root.AETools.sync = { mount };
})(window);
