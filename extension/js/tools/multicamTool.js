/**
 * multicamTool.js — aba "Multicâmera" (edição multicâmera dentro da timeline).
 *
 * Com as faixas já sincronizadas: lê os microfones (um por pessoa), detecta quem
 * fala (AEMcVad), monta o plano de câmeras e microfones (AEMcPlan) e cria uma
 * CÓPIA da sequência com os clipes cortados e os trechos fora do ar
 * desativados (host mcStart/mcStep: clone + lâmina, sem XML → sem itens
 * repetidos). A original não é tocada. O mapa (pessoas, o que cada faixa é)
 * fica salvo por sequência.
 */
(function (root) {
  const { $, setStatus, formatDuration, formatTimecode, confirmDialog, escapeHtml, TICKS_PER_SECOND } = AEUI;
  const TPS = TICKS_PER_SECOND;
  const fs = require("fs");
  const pathMod = require("path");
  const HOP = 0.02;
  const CAM_COLORS = ["#8C4EDB", "#FACE95", "#5FB7C4", "#E07A9B", "#7FCB8A", "#B9B1CC", "#E8A93B", "#6E7BE0"];
  const PERSON_COLORS = ["#C9A6F5", "#FACE95", "#8FD3DC", "#F2A7BF", "#A9DFB1", "#D9D3E6", "#F4C77A", "#A5AEF0"];
  const MAPS_FILE = "multicam-mapas.json";

  function mount(app) {
    const els = {
      people: $("mcPeople"), addPerson: $("mcAddPerson"), map: $("mcMap"), mapHint: $("mcMapHint"),
      interaction: $("mcInteraction"), interactionVal: $("mcInteractionVal"), dynamism: $("mcDynamism"), dynamismVal: $("mcDynamismVal"),
      minShot: $("mcMinShot"), shortUtter: $("mcShortUtter"), micHold: $("mcMicHold"),
      summary: $("mcSummary"), result: $("mcResult"), canvas: $("mcViz"), vizWrap: $("mcVizWrap"), tooltip: $("mcTooltip"), legend: $("mcLegend"),
      notice: $("mcNotice"), progress: $("mcProgress"), progressBar: $("mcProgressBar"),
      analyze: $("mcAnalyze"), create: $("mcCreate"), status: $("mcStatus"), suggest: $("mcSuggest"),
    };
    const prefs = AEStore.loadPrefs("multicam", { interaction: 25, dynamism: 25, minShot: 2.5, shortUtter: 1.5, micHold: 3 });
    const state = { seqId: null, info: null, loading: false, map: null, speech: null, range: null, plan: null, busy: false };

    // --------------------------------------------------------------- mapa salvo
    function loadMap(seqId) {
      const all = AEStore.readJson(MAPS_FILE, {});
      return all[seqId] || { people: ["Pessoa 1", "Pessoa 2"], video: {}, audio: {} };
    }
    function saveMap() {
      if (!state.seqId || !state.map) return;
      const all = AEStore.readJson(MAPS_FILE, {});
      all[state.seqId] = state.map;
      try { AEStore.writeJson(MAPS_FILE, all); } catch (e) { /* sem disco: segue na memória */ }
    }
    const ruleOf = (kind, t) => (state.map[kind][t] || { type: "ignore" });

    // --------------------------------------------------------------- pessoas
    function renderPeople() {
      const m = state.map;
      els.people.innerHTML = m.people.map((name, i) => `
        <div class="mc-person">
          <i style="background:${PERSON_COLORS[i % PERSON_COLORS.length]}"></i>
          <input class="input" data-i="${i}" value="${escapeHtml(name)}" aria-label="Nome da pessoa ${i + 1}" />
          <button class="icon-btn" data-del="${i}" type="button" title="Remover" ${m.people.length <= 1 ? "disabled" : ""}>×</button>
        </div>`).join("");
      els.people.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
        m.people[Number(inp.dataset.i)] = inp.value.trim() || `Pessoa ${Number(inp.dataset.i) + 1}`;
        saveMap(); renderMap(); invalidatePlan();
      }));
      els.people.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
        const i = Number(b.dataset.del);
        m.people.splice(i, 1);
        // microfone dessa pessoa volta a Ignorar; câmera só tira a pessoa de "quem aparece"; índices acima descem
        for (const kind of ["video", "audio"]) for (const t of Object.keys(m[kind])) {
          const r = m[kind][t];
          if (!r.people) continue;
          if (kind === "audio" && r.people.includes(i)) { m[kind][t] = { type: "ignore" }; continue; }
          r.people = r.people.filter((p) => p !== i).map((p) => (p > i ? p - 1 : p));
        }
        saveMap(); renderPeople(); renderMap(); invalidate("Pessoas mudaram — analise de novo.");
      }));
    }
    els.addPerson.addEventListener("click", () => {
      if (!state.map) return;
      state.map.people.push(`Pessoa ${state.map.people.length + 1}`);
      saveMap(); renderPeople(); renderMap();
    });

    // --------------------------------------------------------------- faixas
    function trackLabel(kind, t) {
      const tr = state.info && state.info[kind][t];
      const first = tr && tr.clips.find((c) => c.path);
      const file = first ? pathMod.basename(first.path) : tr && tr.clips.length ? tr.clips[0].name : "vazia";
      return { tag: (kind === "video" ? "V" : "A") + (t + 1), file, empty: !tr || !tr.clips.length };
    }
    function optionsFor(kind) {
      const p = state.map.people;
      if (kind === "video") return [["ignore", "Ignorar"], ["disable", "Desativar"], ["camera", "Câmera"]];
      return [["ignore", "Ignorar"], ["disable", "Desativar"]].concat(p.map((n, i) => [`mic:${i}`, `Microfone de ${n}`]));
    }
    // câmera: a pessoa marca QUEM APARECE; o tipo sai disso (1 = fechada, todas = aberta, senão média).
    // Mapas salvos antes (close/media/aberta) contam como câmera com as mesmas pessoas.
    const isCamera = (r) => r.type === "camera" || r.type === "close" || r.type === "media" || r.type === "aberta";
    const valueOf = (r) => (isCamera(r) ? "camera" : r.type === "mic" ? `mic:${r.people[0]}` : r.type);
    function camKind(people) {
      const n = state.map.people.length;
      return people.length === 1 && n > 1 ? "close" : people.length >= n ? "aberta" : "media";
    }
    const KIND_LABEL = { close: "fechada", media: "média", aberta: "aberta" };

    function renderMap() {
      if (!state.info) {
        els.map.innerHTML = "";
        return;
      }
      const rows = [];
      for (const kind of ["video", "audio"]) {
        rows.push(`<div class="mc-sep">${kind === "video" ? "Vídeo" : "Áudio"}</div>`);
        state.info[kind].forEach((_, t) => {
          const l = trackLabel(kind, t), r = ruleOf(kind, t), v = valueOf(r);
          rows.push(`<div class="mc-row${r.type === "ignore" ? " mc-row--off" : ""}">
            <span class="mc-track">${l.tag}</span>
            <span class="mc-name" title="${escapeHtml(l.file)}">${escapeHtml(l.file)}</span>
            <select class="input" data-kind="${kind}" data-t="${t}" ${l.empty ? "disabled" : ""}>
              ${optionsFor(kind).map(([val, txt]) => `<option value="${val}" ${val === v ? "selected" : ""}>${escapeHtml(txt)}</option>`).join("")}
            </select>
            ${kind === "video" && isCamera(r) ? `<div class="mc-who"><span class="mc-who-label">Quem aparece</span>${state.map.people.map((n, i) => `<label class="switch"><input type="checkbox" data-who="${t}:${i}" ${(r.people || []).includes(i) ? "checked" : ""} /><span class="switch-track"></span>${escapeHtml(n)}</label>`).join("")}<span class="mc-kind" data-kind-of="${t}">${(r.people || []).length ? "→ " + KIND_LABEL[camKind(r.people)] : "marque quem aparece"}</span></div>` : ""}
          </div>`);
        });
      }
      els.map.innerHTML = rows.join("");
      els.map.querySelectorAll("select").forEach((sel) => sel.addEventListener("change", () => setRule(sel.dataset.kind, Number(sel.dataset.t), sel.value)));
      els.map.querySelectorAll("[data-who]").forEach((cb) => cb.addEventListener("change", () => {
        const [t, i] = cb.dataset.who.split(":");
        const r = state.map.video[t];
        const p = Number(i);
        r.type = "camera";
        r.people = cb.checked ? [...new Set((r.people || []).concat(p))].sort((a, b) => a - b) : (r.people || []).filter((x) => x !== p);
        const lab = els.map.querySelector(`[data-kind-of="${t}"]`);
        if (lab) lab.textContent = r.people.length ? "→ " + KIND_LABEL[camKind(r.people)] : "marque quem aparece";
        saveMap(); invalidatePlan();
      }));
    }

    function setRule(kind, t, value) {
      const m = state.map;
      const [type, who] = value.split(":");
      const old = m[kind][t];
      const rule = { type };
      if (who != null) rule.people = [Number(who)];
      else if (type === "camera") rule.people = old && isCamera(old) ? (old.people || []) : [];
      m[kind][t] = rule;
      // câmera marcada (ou vídeo desativado, ex.: corte ao vivo): o áudio embutido dele
      // (vinculado) vira Desativar se estava Ignorar
      if (kind === "video" && (type === "camera" || type === "disable")) {
        for (const at of linkedAudioTracks(t)) if (!m.audio[at] || m.audio[at].type === "ignore") m.audio[at] = { type: "disable" };
      }
      saveMap(); renderMap();
      // microfone mudou: as falas precisam ser lidas de novo; câmera mudou: só o plano
      if (kind === "audio") invalidate("Microfones mudaram — analise de novo.");
      else invalidatePlan();
    }

    function linkedAudioTracks(v) {
      const out = new Set();
      const tr = state.info && state.info.video[v];
      if (tr) for (const c of tr.clips) for (const [at] of c.linked || []) out.add(at);
      return [...out];
    }

    // --------------------------------------------------------------- sequência
    async function loadSequence(force) {
      const seq = app.info && app.info.sequence;
      if (!seq) {
        state.seqId = null; state.info = null;
        els.map.innerHTML = "";
        els.people.innerHTML = "";
        els.mapHint.textContent = "Abra a sequência já sincronizada na Timeline.";
        refreshButtons();
        return;
      }
      if (!force && seq.id === state.seqId && state.info) return;
      if (state.loading) return;
      state.loading = true;
      try {
        const info = await AEHost.call("mcInfo", { seqId: seq.id });
        if (seq.id !== state.seqId) { state.speech = null; state.plan = null; }
        state.seqId = seq.id;
        state.info = info;
        state.map = loadMap(seq.id);
        renderPeople(); renderMap(); renderResult();
      } catch (err) {
        setStatus(els.status, err.message, "error");
      } finally {
        state.loading = false;
        refreshButtons();
      }
    }

    // --------------------------------------------------------------- análise
    function cameras() {
      const out = [];
      state.info.video.forEach((_, t) => {
        const r = ruleOf("video", t);
        if (isCamera(r) && (r.people || []).length) out.push({ track: t, kind: camKind(r.people), people: r.people });
      });
      return out;
    }
    function micTracks() {
      const out = [];
      state.info.audio.forEach((_, t) => { const r = ruleOf("audio", t); if (r.type === "mic") out.push({ track: t, person: r.people[0] }); });
      return out;
    }

    function currentRange() {
      const range = state.info.range || { from: 0, to: state.info.end };
      return { fromSec: range.from / TPS, toSec: range.to / TPS };
    }

    /**
     * Nível (dB a cada 20 ms, na timeline) de grupos de faixas de áudio — cada grupo vira uma
     * série (o máximo entre as faixas do grupo). Lê os arquivos direto do disco.
     */
    async function readLevels(groups, fromSec, toSec, p0, p1) {
      const N = Math.max(1, Math.floor((toSec - fromSec) / HOP));
      const levels = groups.map(() => new Float32Array(N).fill(-120));
      const issues = [], clips = [], opened = new Map();
      groups.forEach((tracks, g) => {
        for (const t of tracks) for (const c of state.info.audio[t].clips) {
          if (c.disabled) continue;
          const s = c.start / TPS, e = c.end / TPS;
          if (e <= fromSec || s >= toSec) continue;
          clips.push({ g, c, s, e });
        }
      });
      const totalSec = clips.reduce((n, x) => n + Math.min(x.e, toSec) - Math.max(x.s, fromSec), 0) || 1;
      let doneSec = 0;
      try {
        for (let i = 0; i < clips.length; i++) {
          const { g, c, s, e } = clips[i];
          const a = Math.max(s, fromSec), b = Math.min(e, toSec);
          setStatus(els.status, `Lendo áudio ${i + 1} de ${clips.length}: ${c.name}`);
          try {
            if (!c.path) throw new Error("clipe sem arquivo de mídia");
            let media = opened.get(c.path);
            if (!media) { media = AEContainers.openMedia(c.path); opened.set(c.path, media); }
            const srcFrom = c.inPoint / TPS + (a - s);
            const env = await AELevels.mediaEnvelope(media, srcFrom, srcFrom + (b - a), AEDecode.decode, (f) => progress(p0 + (p1 - p0) * (doneSec + f * (b - a)) / totalSec));
            const ms = env.ms, off = Math.round((env.startSec - srcFrom) * 1000); // env pode começar um pouco antes
            const lv = levels[g];
            for (let k = Math.max(0, Math.ceil((a - fromSec) / HOP)); k < Math.min(N, Math.floor((b - fromSec) / HOP)); k++) {
              const i0 = Math.floor((fromSec + k * HOP - a) * 1000) - off;
              if (i0 < 0 || i0 + 20 > ms.length) continue;
              let sum = 0;
              for (let q = 0; q < 20; q++) sum += ms[i0 + q];
              const db = sum > 20e-12 ? 10 * Math.log10(sum / 20) : -120;
              if (db > lv[k]) lv[k] = db;
            }
          } catch (err) {
            issues.push(`${c.name}: ${err.message}`);
          }
          doneSec += b - a;
        }
      } finally {
        for (const md of opened.values()) try { md.src.close(); } catch (e) {}
      }
      return { levels, issues };
    }

    // --------------------------------------------------------------- sugerir mapa
    /** quadro JPEG → 64×36 cinza normalizado (para achar o corte ao vivo) */
    async function jpegToGray(jpeg) {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      const cv = document.createElement("canvas");
      cv.width = 64; cv.height = 36;
      const g = cv.getContext("2d");
      g.drawImage(bmp, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data, gray = new Uint8Array(64 * 36);
      for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
      return AEMcMap.normalizeGray(gray);
    }
    const clipAt = (tr, t) => tr.clips.find((c) => !c.disabled && c.path && c.start / TPS <= t && t < c.end / TPS);
    const mediaTime = (c, t) => c.inPoint / TPS + (t - c.start / TPS);

    /**
     * Preenche o mapa sozinho (só o que está em Ignorar): mix e microfones pelo áudio, uma pessoa
     * por microfone; corte ao vivo pelos quadros; quem aparece em cada câmera pela boca nos trechos
     * em que uma pessoa fala sozinha. ~2 min (usa o ffmpeg e o detector de rosto do Sincronizar).
     */
    async function suggestMap() {
      if (state.busy) return;
      await loadSequence(true);
      if (!state.info) return setStatus(els.status, "Nenhuma sequência aberta na Timeline.", "error");
      if (!root.AESyncVisual || !root.AEMcMap) return setStatus(els.status, "A sugestão do mapa não está disponível nesta instalação.", "error");
      const ffOk = AESyncFfmpeg.find();
      if (!ffOk.ok) return setStatus(els.status, "A sugestão do mapa precisa do ffmpeg do Rhythm: " + ffOk.reason, "error");
      const m = state.map, info = state.info, t0 = Date.now();
      setBusy(true);
      let eng = null;
      const notes = [];
      try {
        const { fromSec, toSec } = currentRange();
        // 1) áudio: faixas sem vínculo com vídeo = microfones ou mix
        const linked = new Set();
        info.video.forEach((tr) => tr.clips.forEach((c) => (c.linked || []).forEach(([at]) => linked.add(at))));
        const free = info.audio.map((tr, t) => t).filter((t) => !linked.has(t) && info.audio[t].clips.some((c) => c.path && !c.disabled));
        if (!free.length) throw new Error("não achei faixas de áudio separadas (microfones) na sequência.");
        setStatus(els.status, "Lendo os microfones…");
        const { levels } = await readLevels(free.map((t) => [t]), fromSec, toSec, 0, 0.3);
        const mix = AEMcMap.detectMix(levels).mix;
        const micTracks = free.filter((_, i) => !mix[i]);
        free.forEach((t, i) => { if (mix[i] && ruleOf("audio", t).type === "ignore") { m.audio[t] = { type: "disable" }; notes.push(`A${t + 1} = mix`); } });
        // pessoa de cada microfone: a já marcada, ou uma nova
        const personOf = new Map();
        for (const t of micTracks) {
          const r = ruleOf("audio", t);
          if (r.type === "mic") { personOf.set(t, r.people[0]); continue; }
          if (r.type !== "ignore") continue; // Desativar escolhido à mão
          const used = new Set([...personOf.values(), ...Object.values(m.audio).filter((x) => x.type === "mic").map((x) => x.people[0])]);
          let p = 0;
          while (used.has(p)) p++;
          while (m.people.length <= p) m.people.push(`Pessoa ${m.people.length + 1}`);
          m.audio[t] = { type: "mic", people: [p] };
          personOf.set(t, p);
        }
        const nP = m.people.length;
        const groups = [...Array(nP)].map((_, p) => micTracks.filter((t) => personOf.get(t) === p).map((t) => free.indexOf(t)));
        const N = levels[0].length;
        const personLv = groups.map((idx) => { const lv = new Float32Array(N).fill(-120); for (const i of idx) for (let k = 0; k < N; k++) if (levels[i][k] > lv[k]) lv[k] = levels[i][k]; return lv; });
        const vad = AEMcVad.analyze(personLv);
        const speech = vad.segs.map((s) => s.map(([x, y]) => [x + fromSec, y + fromSec]));
        // 2) corte ao vivo: quadro igual ao de outra faixa quase sempre
        const exe = ffOk.exe, probes = new Map();
        const probe = (f) => { if (!probes.has(f)) probes.set(f, AESyncFfmpeg.probe(exe, f)); return probes.get(f); };
        const vids = info.video.map((tr, t) => t).filter((t) => info.video[t].clips.some((c) => c.path && !c.disabled && c.kind !== "graphic"));
        const times = [...Array(8)].map((_, i) => fromSec + ((toSec - fromSec) * (i + 0.5)) / 8);
        const frames = [];
        for (let vi = 0; vi < vids.length; vi++) {
          const tr = info.video[vids[vi]], row = [];
          setStatus(els.status, `Comparando as câmeras (V${vids[vi] + 1})…`);
          for (const t of times) {
            const c = clipAt(tr, t);
            let still = null;
            if (c) { try { await AESyncFfmpeg.frames(exe, c.path, probe(c.path), { ss: mediaTime(c, t), still: true }, (j) => (still = j)); } catch (e) {} }
            row.push(still ? await jpegToGray(still) : null);
          }
          frames.push(row);
          progress(0.3 + 0.15 * (vi + 1) / vids.length);
        }
        const prog = AEMcMap.detectProgram(frames);
        if (prog >= 0 && ruleOf("video", vids[prog]).type === "ignore") { setVideoRule(vids[prog], { type: "disable" }); notes.push(`V${vids[prog] + 1} = corte ao vivo`); }
        // 3) quem aparece em cada câmera, pela boca
        const windows = AEMcMap.pickWindows(speech, fromSec, toSec);
        if (!windows.length) throw new Error("não achei trechos em que uma pessoa fala sozinha.");
        eng = AESyncVisual.create({});
        await eng.pool.ready;
        const camTracks = vids.filter((t, i) => i !== prog && ruleOf("video", t).type === "ignore");
        for (let ci = 0; ci < camTracks.length; ci++) {
          const v = camTracks[ci], tr = info.video[v];
          setStatus(els.status, `Procurando rostos na V${v + 1} (${ci + 1} de ${camTracks.length})…`);
          // o clipe que cobre mais trechos dá os rostos
          const byClip = new Map();
          windows.forEach((w, wi) => { const c = clipAt(tr, (w.s + w.e) / 2); if (c) (byClip.get(c) || byClip.set(c, []).get(c)).push(wi); });
          const main = [...byClip.entries()].sort((a, b) => b[1].length - a[1].length)[0];
          if (!main) { notes.push(`V${v + 1}: sem clipe nos trechos de fala`); continue; }
          const c = main[0], cinfo = probe(c.path), sig = { cancelled: false };
          const people = await eng.findPeople(c.path, cinfo, sig);
          if (!people.length) { notes.push(`V${v + 1}: nenhum rosto`); continue; }
          const motion = people.map(() => windows.map(() => null));
          for (const wi of main[1]) {
            const w = windows[wi];
            const ser = await eng.mouthSeries(c.path, cinfo, people, { ss: mediaTime(c, w.s), t: w.e - w.s }, sig);
            people.forEach((_, f) => {
              let prev = null, s = 0, n = 0;
              for (const fr of ser) { const x = fr.open[f]; if (x == null) { prev = null; continue; } if (prev != null) { s += Math.abs(x - prev); n++; } prev = x; }
              motion[f][wi] = n ? s / n : null;
            });
          }
          const res = AEMcMap.cameraPeople(AEMcMap.faceScores(motion, windows, nP), nP);
          if (res.people.length) setVideoRule(v, { type: "camera", people: res.people });
          else notes.push(`V${v + 1}: rostos sem boca casada com algum microfone`);
          progress(0.45 + 0.55 * (ci + 1) / camTracks.length);
        }
        saveMap(); renderPeople(); renderMap();
        // as falas já estão prontas: a prévia aparece sem analisar de novo
        state.speech = speech;
        state.range = { from: fromSec, to: toSec, marked: !!info.range };
        state.issues = [];
        state.warnSync = false;
        replan();
        setStatus(els.status, `Mapa sugerido em ${formatDuration((Date.now() - t0) / 1000)}${notes.length ? ` (${notes.join(" · ")})` : ""}. Confira as faixas, dê nome às pessoas e ajuste se precisar.`, "success");
      } catch (err) {
        setStatus(els.status, "Não deu para sugerir o mapa: " + err.message, "error");
      } finally {
        if (eng) try { eng.close(); } catch (e) {}
        setBusy(false);
      }
    }

    /** regra de vídeo vinda da sugestão (com o áudio vinculado indo junto para Desativar) */
    function setVideoRule(t, rule) {
      const m = state.map;
      m.video[t] = rule;
      for (const at of linkedAudioTracks(t)) if (!m.audio[at] || m.audio[at].type === "ignore") m.audio[at] = { type: "disable" };
    }

    async function analyze() {
      if (state.busy) return;
      await loadSequence(true);
      if (!state.info) return setStatus(els.status, "Nenhuma sequência aberta na Timeline.", "error");
      const empty = state.info.video.findIndex((_, t) => { const r = ruleOf("video", t); return isCamera(r) && !(r.people || []).length; });
      if (empty >= 0) return setStatus(els.status, `V${empty + 1}: marque quem aparece nessa câmera.`, "error");
      const cams = cameras(), mics = micTracks();
      if (!cams.length) return setStatus(els.status, "Marque pelo menos uma faixa de vídeo como Câmera.", "error");
      if (!mics.length) return setStatus(els.status, "Marque o microfone de pelo menos uma pessoa.", "error");
      setBusy(true);
      try {
        const { fromSec, toSec } = currentRange();
        const nP = state.map.people.length;
        const groups = [...Array(nP)].map((_, p) => mics.filter((m) => m.person === p).map((m) => m.track));
        const { levels, issues } = await readLevels(groups, fromSec, toSec, 0, 0.9);
        setStatus(els.status, "Detectando quem fala…");
        const vad = AEMcVad.analyze(levels);
        state.speech = vad.segs.map((segs) => segs.map(([x, y]) => [x + fromSec, y + fromSec]));
        state.range = { from: fromSec, to: toSec, marked: !!state.info.range };
        state.issues = issues;
        state.warnSync = looksUnsynced(cams, mics);
        progress(1);
        replan();
        const talk = state.speech.map((s, p) => `${state.map.people[p]} ${formatDuration(s.reduce((n, g) => n + g[1] - g[0], 0))}`).join(" · ");
        setStatus(els.status, `Falas detectadas: ${talk}. Ajuste o ritmo e crie a cópia.`, issues.length ? "warn" : "success");
      } catch (err) {
        setStatus(els.status, "Erro na análise: " + err.message, "error");
      } finally {
        setBusy(false);
      }
    }

    /** tudo começando no mesmo ponto = provavelmente ninguém sincronizou ainda */
    function looksUnsynced(cams, mics) {
      const starts = [];
      for (const c of cams) { const tr = state.info.video[c.track]; if (tr.clips.length) starts.push(tr.clips[0].start); }
      for (const m of mics) { const tr = state.info.audio[m.track]; if (tr.clips.length) starts.push(tr.clips[0].start); }
      return starts.length >= 3 && starts.every((s) => s === starts[0]);
    }

    // --------------------------------------------------------------- plano e prévia
    function planOpts() {
      return {
        interaction: Number(els.interaction.value) / 100,
        dynamism: Number(els.dynamism.value) / 100,
        minShot: Number(els.minShot.value) || 2.5,
        shortUtter: Number(els.shortUtter.value) || 0,
        micHold: Number(els.micHold.value) || 0,
      };
    }
    function replan() {
      if (!state.speech || !state.info) return;
      const cams = cameras();
      if (!cams.length) { state.plan = null; renderResult(); return; }
      const o = planOpts();
      const shots = AEMcPlan.planCameras(state.speech, cams, state.range.from, state.range.to, o);
      const mics = AEMcPlan.planMics(state.speech, state.range.from, state.range.to, o);
      state.plan = { cams, shots, mics, summary: AEMcPlan.summarize(shots, cams, mics) };
      renderResult();
    }
    function invalidatePlan() { replan(); refreshButtons(); }
    function invalidate(msg) {
      if (!state.speech) return;
      state.speech = null; state.plan = null;
      renderResult();
      setStatus(els.status, msg);
      refreshButtons();
    }

    function camName(c) {
      const p = state.map.people;
      if (c.kind === "aberta") return `V${c.track + 1} · aberta`;
      if (c.kind === "close") return `V${c.track + 1} · ${p[c.people[0]] || "?"}`;
      return `V${c.track + 1} · ${c.people.map((i) => p[i]).join(" + ")}`;
    }

    function renderResult() {
      const P = state.plan;
      els.result.hidden = !P;
      if (!P) { els.summary.innerHTML = ""; els.notice.hidden = true; return; }
      const fps = TPS / state.info.timebase;
      const r = state.range, S = P.summary;
      const pct = (x) => `${Math.round(100 * x)}%`;
      const items = [
        `Trecho: ${r.marked ? `In/Out ${formatTimecode(r.from, fps)}–${formatTimecode(r.to, fps)}` : `sequência inteira (${formatDuration(r.to - r.from)})`}`,
        `${S.cuts} corte(s) · plano mediano ${formatDuration(S.medianShot)}`,
        `No ar: ${[S.share.close ? `fechada ${pct(S.share.close)}` : "", S.share.media ? `média ${pct(S.share.media)}` : "", S.share.aberta ? `aberta ${pct(S.share.aberta)}` : ""].filter(Boolean).join(" · ")}`,
        `Microfones: ${S.micCuts} trecho(s) ligados`,
      ];
      els.summary.innerHTML = items.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
      els.legend.innerHTML = P.cams.map((c, i) => `<span><i style="background:${CAM_COLORS[i % CAM_COLORS.length]}"></i>${escapeHtml(camName(c))}</span>`).join("")
        + state.map.people.map((n, i) => `<span><i style="background:${PERSON_COLORS[i % PERSON_COLORS.length]};opacity:.75"></i>mic ${escapeHtml(n)}</span>`).join("");
      const notes = [];
      if (state.warnSync) notes.push("As faixas parecem não sincronizadas (tudo começa no mesmo ponto). Se for o caso, use a aba Sincronizar antes.");
      if (state.issues && state.issues.length) notes.push(`Não li ${state.issues.length} clipe(s) de microfone: ${state.issues.slice(0, 3).map(escapeHtml).join("; ")}`);
      els.notice.hidden = !notes.length;
      els.notice.innerHTML = notes.join("<br>");
      draw();
    }

    function draw() {
      const P = state.plan;
      if (!P) return;
      const W = Math.max(200, els.vizWrap.clientWidth), dpr = window.devicePixelRatio || 1;
      const nP = state.map.people.length, camH = 20, rowH = 7, gap = 3;
      const H = camH + 6 + nP * (rowH + gap);
      const cv = els.canvas;
      cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
      const g = cv.getContext("2d");
      g.scale(dpr, dpr);
      g.clearRect(0, 0, W, H);
      const { from, to } = state.range;
      const x = (t) => ((t - from) / (to - from)) * W;
      for (const s of P.shots) { g.fillStyle = CAM_COLORS[s.cam % CAM_COLORS.length]; g.fillRect(x(s.s), 0, Math.max(1, x(s.e) - x(s.s)), camH); }
      g.fillStyle = "rgba(7,0,16,0.6)";
      for (let i = 1; i < P.shots.length; i++) g.fillRect(Math.floor(x(P.shots[i].s)), 0, 1, camH);
      P.mics.forEach((m, p) => {
        const y = camH + 6 + p * (rowH + gap);
        g.fillStyle = "rgba(255,255,255,0.05)"; g.fillRect(0, y, W, rowH);
        g.fillStyle = PERSON_COLORS[p % PERSON_COLORS.length];
        for (const [a, b] of m) g.fillRect(x(a), y, Math.max(1, x(b) - x(a)), rowH);
      });
    }
    window.addEventListener("resize", () => { if (state.plan && !els.result.hidden) draw(); });
    els.vizWrap.addEventListener("mousemove", (ev) => {
      const P = state.plan;
      if (!P) return;
      const rect = els.vizWrap.getBoundingClientRect();
      const t = state.range.from + ((ev.clientX - rect.left) / rect.width) * (state.range.to - state.range.from);
      const sh = P.shots.find((s) => s.s <= t && t < s.e);
      const fps = TPS / state.info.timebase;
      els.tooltip.hidden = false;
      els.tooltip.style.left = Math.min(rect.width - 150, Math.max(0, ev.clientX - rect.left + 8)) + "px";
      els.tooltip.textContent = `${formatTimecode(t, fps)} · ${sh ? camName(P.cams[sh.cam]) : "—"}`;
    });
    els.vizWrap.addEventListener("mouseleave", () => { els.tooltip.hidden = true; });

    // --------------------------------------------------------------- criação
    async function create() {
      if (!state.plan || state.busy) return;
      const seq = app.info && app.info.sequence;
      if (!seq || seq.id !== state.seqId) return setStatus(els.status, "Volte para a sequência analisada na Timeline.", "error");
      const P = state.plan, tb = state.info.timebase;
      const fr = (sec) => Math.round((sec * TPS) / tb) * tb;
      const ranges = (list) => list.map(([a, b]) => [fr(a), fr(b)]).filter(([a, b]) => b > a);
      const camOn = P.cams.map((_, i) => ranges(P.shots.filter((s) => s.cam === i).map((s) => [s.s, s.e])));
      const video = state.info.video.map((_, t) => {
        const r = ruleOf("video", t);
        if (r.type === "ignore") return "ignore";
        if (r.type === "disable") return "disable";
        const ci = P.cams.findIndex((c) => c.track === t);
        return ci >= 0 ? camOn[ci] : "ignore";
      });
      const audio = state.info.audio.map((_, t) => {
        const r = ruleOf("audio", t);
        if (r.type === "ignore") return "ignore";
        if (r.type === "mic") return ranges(P.mics[r.people[0]] || []);
        // Desativar: se for o áudio vinculado de uma câmera cortada, corta nos mesmos pontos (pares vídeo/áudio)
        const owner = state.info.video.findIndex((tr, v) => Array.isArray(video[v]) && tr.clips.some((c) => (c.linked || []).some(([at]) => at === t)));
        return owner >= 0 ? { cutsLike: owner } : "disable";
      });
      const name = `${state.info.name} (Multicâmera)`;
      const ok = await confirmDialog("Criar multicâmera", `Uma cópia de "${state.info.name}" será criada com ${P.summary.cuts} corte(s) de câmera e ${P.summary.micCuts} trecho(s) de microfone ligados. Os trechos fora do ar ficam desativados na pilha. A sequência original não é alterada.`, "Criar cópia");
      if (!ok) return;
      setBusy(true);
      const t0 = Date.now();
      try {
        setStatus(els.status, "Duplicando a sequência…");
        const range = { from: fr(state.range.from), to: fr(state.range.to) };
        const job = await AEHost.call("mcStart", { srcSeqId: state.seqId, name, bin: "Rhythm · Multicâmera", range, video, audio });
        let r;
        for (;;) {
          r = await AEHost.call("mcStep", { seqId: job.id, budgetMs: 2000 });
          const f = r.total ? r.processed / r.total : 1;
          progress(f);
          if (r.done) break;
          const el = (Date.now() - t0) / 1000;
          setStatus(els.status, `${r.processed < r.total && r.razors < r.total ? "Cortando" : "Ativando e desativando"} ${r.processed}/${r.total}${f > 0.05 ? ` · falta ~${formatDuration(Math.max(1, (el / f) * (1 - f)))}` : ""}`);
        }
        writeLog(`criação ${formatDuration((Date.now() - t0) / 1000)} · ${P.summary.cuts} cortes de câmera · ${P.summary.micCuts} trechos de microfone · ${r.razors} lâminas · ${r.on} ativos · ${r.off} desativados`);
        setStatus(els.status, `"${job.name}" criada e aberta (pasta "Rhythm · Multicâmera").`, "success");
      } catch (err) {
        setStatus(els.status, "Erro ao criar: " + err.message, "error");
      } finally {
        setBusy(false);
        app.refreshInfo();
      }
    }

    /** Diagnóstico: uma linha por criação em %APPDATA%\AutomacaoEdicao\multicam-log.txt (últimas ~200). */
    function writeLog(line) {
      try {
        const file = pathMod.join(AEStore.dataDir(), "multicam-log.txt");
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
        fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
      } catch (e) { /* log é só diagnóstico */ }
    }

    // --------------------------------------------------------------- geral
    function progress(f) {
      els.progress.hidden = f >= 1 && !state.busy;
      els.progressBar.style.width = `${Math.round(Math.min(1, f) * 100)}%`;
    }
    function setBusy(b) {
      state.busy = b;
      els.progress.hidden = !b;
      if (b) progress(0);
      refreshButtons();
    }
    function refreshButtons() {
      els.analyze.disabled = state.busy || !state.info;
      els.create.disabled = state.busy || !state.plan;
      els.addPerson.disabled = state.busy || !state.info;
      els.suggest.disabled = state.busy || !state.info;
    }
    function bindRange(el, val, key) {
      const show = () => { val.textContent = el.value; };
      show();
      el.addEventListener("input", () => { show(); prefs[key] = Number(el.value); AEStore.savePrefs("multicam", prefs); replan(); });
    }
    els.interaction.value = prefs.interaction; els.dynamism.value = prefs.dynamism;
    els.minShot.value = prefs.minShot; els.shortUtter.value = prefs.shortUtter; els.micHold.value = prefs.micHold;
    bindRange(els.interaction, els.interactionVal, "interaction");
    bindRange(els.dynamism, els.dynamismVal, "dynamism");
    for (const [el, key] of [[els.minShot, "minShot"], [els.shortUtter, "shortUtter"], [els.micHold, "micHold"]]) {
      el.addEventListener("change", () => { prefs[key] = Number(el.value); AEStore.savePrefs("multicam", prefs); replan(); });
    }
    els.analyze.addEventListener("click", analyze);
    els.suggest.addEventListener("click", suggestMap);
    els.create.addEventListener("click", create);
    refreshButtons();

    return {
      onInfo(info) {
        // durante a criação a sequência ativa troca entre a cópia e a original: não recarregar
        if (state.busy || app.active !== "multicam") return;
        const seq = info && info.sequence;
        if ((seq ? seq.id : null) !== state.seqId) loadSequence(false);
      },
      onShow() { if (!state.busy) loadSequence(false); },
    };
  }

  root.AETools = root.AETools || {};
  root.AETools.multicam = { mount };
})(window);
