/**
 * interleaveTool.js — Aba 2: Áudio Intercalado (J-Cut / L-Cut).
 *
 * A prévia (o que vai acontecer) é recalculada a cada mudança. Aplicar
 * grava um registro do que foi feito em arquivo; "Desfazer Tudo" reverte
 * só essas mudanças, mesmo depois de outras edições ou de reabrir o Premiere.
 */
(function (root) {
  const { $, setStatus, bindNumber, bindSegmented, confirmDialog, debounce, formatTimecode, TICKS_PER_SECOND: TPS } = AEUI;
  const UNDO_FILE = "intercalado-desfazer.json";
  const DEFAULTS = { type: "both", frames: 6 };

  function mount(app) {
    const prefs = AEStore.loadPrefs("interleave", DEFAULTS);
    const els = {
      src: $("ilSrc"),
      dst: $("ilDst"),
      frames: $("ilFrames"),
      framesHint: $("ilFramesHint"),
      diagram: $("ilDiagram"),
      summary: $("ilSummary"),
      partial: $("ilPartial"),
      apply: $("ilApply"),
      undo: $("ilUndo"),
      status: $("ilStatus"),
    };
    const state = { info: null, plan: null, data: null, busy: false, choice: {}, mediaCache: new Map() };

    const type = bindSegmented($("ilType"), (v) => {
      prefs.type = v;
      save();
      drawDiagram();
      replan();
    });
    type.set(prefs.type);
    els.frames.value = prefs.frames;
    bindNumber(els.frames, (v) => {
      prefs.frames = Math.round(v);
      save();
      framesHint();
      replanSoon();
    });
    els.src.addEventListener("change", () => onTrackChange());
    els.dst.addEventListener("change", () => onTrackChange());
    els.apply.addEventListener("click", apply);
    els.undo.addEventListener("click", undoAll);

    function save() {
      AEStore.savePrefs("interleave", prefs);
    }

    // ---------------------------------------------------------- faixas
    function renderTracks() {
      const info = state.info;
      const seq = info && info.sequence;
      [els.src, els.dst].forEach((s) => (s.innerHTML = ""));
      if (!seq) {
        [els.src, els.dst].forEach((s) => (s.innerHTML = "<option>Sem sequência</option>"));
        return;
      }
      const remembered = state.choice[seq.id] || {};
      const tracks = info.audioTracks;
      const src = remembered.src != null ? remembered.src : (tracks.find((t) => t.clips >= 2) || tracks[0] || {}).index;
      const dst = remembered.dst != null ? remembered.dst : (tracks.find((t) => t.index !== src && t.clips === 0) || tracks.find((t) => t.index !== src) || {}).index;
      tracks.forEach((t) => {
        const label = `A${t.index + 1} · ${t.name} (${t.clips} clipe${t.clips === 1 ? "" : "s"})${t.locked ? " · travada" : ""}`;
        els.src.add(new Option(label, String(t.index), false, t.index === src));
        els.dst.add(new Option(label, String(t.index), false, t.index === dst));
      });
    }

    function onTrackChange() {
      const seq = state.info && state.info.sequence;
      if (seq) state.choice[seq.id] = { src: Number(els.src.value), dst: Number(els.dst.value) };
      state.data = null;
      replan();
    }

    function framesHint() {
      const seq = state.info && state.info.sequence;
      if (!seq) {
        els.framesHint.textContent = "";
        return;
      }
      const ms = Math.round((prefs.frames / seq.fps) * 1000);
      els.framesHint.textContent = `${prefs.frames} frames = ${ms} ms a ${seq.fps.toFixed(3).replace(/\.?0+$/, "").replace(".", ",")} fps${prefs.type === "both" ? " (de cada lado)" : ""}`;
    }

    // ---------------------------------------------------------- diagrama
    function drawDiagram() {
      const t = prefs.type;
      const J = t === "J" || t === "both";
      const L = t === "L" || t === "both";
      const cutX = 150;
      const ext = 34;
      const aEnd = L ? cutX + ext : cutX;
      const bStart = J ? cutX - ext : cutX;
      els.diagram.innerHTML = `
        <text x="2" y="12" fill="#857C9C" font-size="9">VÍDEO</text>
        <rect x="40" y="3" width="${cutX - 41}" height="13" rx="4" fill="#402B6D"/>
        <rect x="${cutX + 1}" y="3" width="${259 - cutX}" height="13" rx="4" fill="#2E1F5B"/>
        <text x="2" y="33" fill="#857C9C" font-size="9">ORIGEM</text>
        <rect x="40" y="24" width="${aEnd - 40}" height="13" rx="4" fill="#47435A"/>
        <text x="2" y="54" fill="#857C9C" font-size="9">DESTINO</text>
        <rect x="${bStart}" y="45" width="${260 - bStart}" height="13" rx="4" fill="#2F2C3D"/>
        ${L ? `<rect x="${cutX}" y="24" width="${ext}" height="13" fill="rgba(140,78,219,0.75)"/>` : ""}
        ${J ? `<rect x="${bStart}" y="45" width="${ext}" height="13" fill="rgba(140,78,219,0.75)"/>` : ""}
        <line x1="${cutX}" y1="0" x2="${cutX}" y2="64" stroke="#FACE95" stroke-dasharray="3 2"/>
        <text x="${cutX + 4}" y="63" fill="#FACE95" font-size="8">corte</text>
        <text x="265" y="33" fill="#B9B1CC" font-size="9">fala 1</text>
        <text x="265" y="54" fill="#B9B1CC" font-size="9">fala 2</text>`;
    }

    // ---------------------------------------------------------- plano
    const replanSoon = debounce(() => replan(), 150);

    function mediaEndFor(clip) {
      if (!clip.path) return clip.mediaEnd || null;
      if (!state.mediaCache.has(clip.path)) {
        let dur = null;
        try {
          const m = AEContainers.openMedia(clip.path);
          dur = m.info.durationSec;
          m.src.close();
        } catch (e) {
          dur = null;
        }
        state.mediaCache.set(clip.path, dur);
      }
      const dur = state.mediaCache.get(clip.path);
      return dur ? Math.round(dur * TPS) : clip.mediaEnd || null;
    }

    async function replan() {
      const seq = state.info && state.info.sequence;
      state.plan = null;
      els.apply.disabled = true;
      els.partial.hidden = true;
      if (!seq) {
        els.summary.innerHTML = "<li>Abra uma sequência na Timeline.</li>";
        return;
      }
      const srcTrack = Number(els.src.value);
      const dstTrack = Number(els.dst.value);
      if (srcTrack === dstTrack) {
        els.summary.innerHTML = '<li style="color:var(--danger)">Origem e destino precisam ser faixas diferentes.</li>';
        return;
      }
      try {
        if (!state.data || state.data.seqId !== seq.id || state.data.srcTrack !== srcTrack || state.data.dstTrack !== dstTrack) {
          const d = await AEHost.call("interleaveClips", { seqId: seq.id, srcTrack, dstTrack });
          d.srcClips.forEach((c) => (c.mediaEnd = mediaEndFor(c)));
          state.data = { ...d, seqId: seq.id, srcTrack, dstTrack };
        }
        const d = state.data;
        const plan = AEInterleavePlan.plan({
          srcTrack,
          dstTrack,
          type: prefs.type,
          frames: prefs.frames,
          timebase: d.timebase,
          srcClips: d.srcClips,
          dstClips: d.dstClips,
        });
        state.plan = plan;
        renderPlan(plan, seq);
      } catch (err) {
        els.summary.innerHTML = `<li style="color:var(--danger)">${AEUI.escapeHtml(err.message)}</li>`;
      }
    }

    function renderPlan(plan, seq) {
      if (!plan.ok) {
        els.summary.innerHTML = `<li style="color:var(--danger)">${AEUI.escapeHtml(plan.error)}</li>`;
        return;
      }
      const s = plan.summary;
      const dst = `A${Number(els.dst.value) + 1}`;
      els.summary.innerHTML = `
        <li>Clipes na origem <b>${s.clips}</b></li>
        <li>Vão para ${dst} <b>${s.moved}</b></li>
        <li>Pontos de edição <b>${s.editPoints}</b></li>
        <li>Completos <b style="color:var(--keep)">${s.full}</b></li>
        <li>Parciais (pouco material) <b style="color:${s.partial ? "var(--warn)" : "inherit"}">${s.partial}</b></li>
        <li>Sem material para esticar <b style="color:${s.none ? "var(--danger)" : "inherit"}">${s.none}</b></li>
        ${s.skippedSpeed ? `<li>Clipes com velocidade alterada (não esticados) <b>${s.skippedSpeed}</b></li>` : ""}`;
      if (s.partialList.length) {
        els.partial.innerHTML = s.partialList
          .map((p) => `<div class="partial-row" data-t="${p.at}"><span>${formatTimecode(p.at / TPS, seq.fps)}</span><span>${p.gotFrames} de ${p.wantFrames} frames</span></div>`)
          .join("");
        els.partial.querySelectorAll(".partial-row").forEach((r) =>
          r.addEventListener("click", () => AEHost.call("seek", { seqId: seq.id, ticks: Number(r.dataset.t) }).catch(() => {}))
        );
        els.partial.hidden = false;
      }
      els.apply.disabled = state.busy;
    }

    // ---------------------------------------------------------- aplicar / desfazer
    function undoRecords(seqId) {
      const all = AEStore.readJson(UNDO_FILE, {});
      return { all, list: all[seqId] || [] };
    }

    function refreshUndoButton() {
      const seq = state.info && state.info.sequence;
      const n = seq ? undoRecords(seq.id).list.length : 0;
      els.undo.disabled = state.busy || !n;
      els.undo.textContent = n ? `Desfazer Tudo (${n})` : "Desfazer Tudo";
    }

    async function apply() {
      const seq = state.info && state.info.sequence;
      const plan = state.plan;
      if (!seq || !plan || !plan.ok || state.busy) return;
      const s = plan.summary;
      const ok = await confirmDialog(
        "Aplicar áudio intercalado?",
        `Move ${s.moved} clipe(s) de A${Number(els.src.value) + 1} para A${Number(els.dst.value) + 1} e estica ${s.editPoints} ponto(s) de edição` +
          `${s.partial + s.none ? ` (${s.partial + s.none} ficarão parciais)` : ""}. O vídeo não é alterado. Dá para reverter com "Desfazer Tudo".`,
        "Aplicar"
      );
      if (!ok) return;

      state.busy = true;
      els.apply.disabled = true;
      els.undo.disabled = true;
      setStatus(els.status, "Aplicando…");
      try {
        const ops = plan.ops.filter((o) => o.move || o.extendStart || o.extendEnd);
        const { results } = await AEHost.call("interleaveApply", {
          seqId: seq.id,
          ops: ops.map((o) => ({ id: o.id, move: o.move, toTrack: o.toTrack, extendStart: o.extendStart, extendEnd: o.extendEnd })),
        });
        const byId = {};
        results.forEach((r) => (byId[r.id] = r));
        const done = ops
          .map((o) => ({ ...o, r: byId[o.id] || {} }))
          .filter((o) => o.r.moved || o.r.extendStart || o.r.extendEnd)
          .map((o) => ({ id: o.id, name: o.name, moved: !!o.r.moved, fromTrack: o.fromTrack, toTrack: o.toTrack, extendStart: o.r.extendStart || 0, extendEnd: o.r.extendEnd || 0 }));
        const errors = results.filter((r) => r.error);

        if (done.length) {
          const { all, list } = undoRecords(seq.id);
          list.push({ when: new Date().toISOString(), seqName: seq.name, type: prefs.type, frames: prefs.frames, ops: done });
          all[seq.id] = list;
          AEStore.writeJson(UNDO_FILE, all);
        }
        const partial = s.partial + s.none;
        if (errors.length) setStatus(els.status, `Aplicado com ${errors.length} erro(s): ${errors[0].error}`, "warn");
        else setStatus(els.status, `Pronto: ${done.filter((o) => o.moved).length} clipe(s) movido(s), ${s.editPoints} ponto(s) de edição${partial ? `, ${partial} parcial(is) — veja a lista` : ""}.`, partial ? "warn" : "success");
        state.data = null;
      } catch (err) {
        setStatus(els.status, `Erro: ${err.message}`, "error");
      } finally {
        state.busy = false;
        await app.refreshInfo();
        refreshUndoButton();
      }
    }

    async function undoAll() {
      const seq = state.info && state.info.sequence;
      if (!seq || state.busy) return;
      const { all, list } = undoRecords(seq.id);
      if (!list.length) return;
      const ok = await confirmDialog(
        "Desfazer o áudio intercalado?",
        `Reverte ${list.length} aplicação(ões) nesta sequência: encolhe os J/L-cuts e devolve os clipes para a faixa de origem. Outras edições suas são mantidas.`,
        "Desfazer Tudo"
      );
      if (!ok) return;
      state.busy = true;
      els.undo.disabled = true;
      els.apply.disabled = true;
      setStatus(els.status, "Desfazendo…");
      let failed = 0;
      let reverted = 0;
      let lastError = "";
      try {
        for (let i = list.length - 1; i >= 0; i--) {
          const rec = list[i];
          const { results } = await AEHost.call("interleaveUndo", { seqId: seq.id, ops: rec.ops });
          const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
          results.filter((r) => !r.ok).forEach((r) => (lastError = r.error));
          reverted += okIds.size;
          rec.ops = rec.ops.filter((o) => !okIds.has(o.id));
          failed += rec.ops.length;
          if (!rec.ops.length) list.splice(i, 1);
        }
        if (list.length) all[seq.id] = list;
        else delete all[seq.id];
        AEStore.writeJson(UNDO_FILE, all);
        if (failed) setStatus(els.status, `${reverted} clipe(s) revertido(s); ${failed} não: ${lastError}`, "warn");
        else setStatus(els.status, `Revertido: ${reverted} clipe(s) voltaram ao estado original.`, "success");
      } catch (err) {
        setStatus(els.status, `Erro ao desfazer: ${err.message}`, "error");
      } finally {
        state.busy = false;
        state.data = null;
        await app.refreshInfo();
        refreshUndoButton();
      }
    }

    drawDiagram();

    return {
      onInfo(info) {
        const before = JSON.stringify(state.info && { s: state.info.sequence && state.info.sequence.id, t: state.info.audioTracks });
        state.info = info;
        const after = JSON.stringify(info && { s: info.sequence && info.sequence.id, t: info.audioTracks });
        if (before !== after) {
          renderTracks();
          framesHint();
          state.data = null;
          if (!state.busy) replan();
        }
        refreshUndoButton();
      },
      onShow() {
        state.data = null;
        if (!state.busy) replan();
      },
    };
  }

  root.AETools = root.AETools || {};
  root.AETools.interleave = { mount };
})(window);
