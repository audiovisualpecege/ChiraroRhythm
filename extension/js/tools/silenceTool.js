/**
 * silenceTool.js — Aba 1: Cortador de Silêncios.
 *
 * Analisar Áudio: lê o áudio dos clipes da timeline direto dos arquivos e
 * monta o envelope da sequência. Depois disso, qualquer mudança de
 * parâmetro recalcula a prévia na hora.
 * Aplicar Cortes: marcadores (sempre) -> backup (opcional) -> ripple delete
 * de cada silêncio, do fim para o começo.
 */
(function (root) {
  const { $, setStatus, formatTime, formatDuration, bindNumber, bindSegmented, confirmDialog, debounce, escapeHtml, TICKS_PER_SECOND: TPS } = AEUI;

  const DEFAULTS = {
    scope: "sequence",
    thresholdDb: -40,
    autoDb: false,
    minSilenceSec: 0.5,
    windowMs: 20,
    marginAfterMs: 100,
    marginBeforeMs: 100,
    backup: false,
  };

  function mount(app) {
    const prefs = AEStore.loadPrefs("silence", DEFAULTS);
    const els = {
      tracks: $("silTracks"),
      scopeHint: $("silScopeHint"),
      threshold: $("silThreshold"),
      auto: $("silAuto"),
      autoHint: $("silAutoHint"),
      minSilence: $("silMinSilence"),
      windowMs: $("silWindow"),
      marginAfter: $("silMarginAfter"),
      marginBefore: $("silMarginBefore"),
      backup: $("silBackup"),
      summary: $("silSummary"),
      summaryText: $("silSummaryText"),
      chevron: $("silChevron"),
      expanded: $("silExpanded"),
      ratioKeep: $("silRatioKeep"),
      ratioCut: $("silRatioCut"),
      ratioFrom: $("silRatioFrom"),
      ratioTo: $("silRatioTo"),
      cutsList: $("silCutsList"),
      notice: $("silNotice"),
      analyze: $("silAnalyze"),
      apply: $("silApply"),
      status: $("silStatus"),
      progress: $("silProgress"),
      progressBar: $("silProgressBar"),
    };

    const state = {
      info: null,
      tracksBySeq: {}, // seqId -> Set de índices escolhidos pelo usuário
      analysis: null,
      result: null,
      expanded: false,
      busy: false,
      focus: -1,
    };

    const view = new AETimelineView({
      canvas: $("vizCanvas"),
      wrap: $("vizWrap"),
      tooltip: $("vizTooltip"),
      onSeek: (sec) => seek(sec),
      onToggleCut: (i) => toggleCut(i),
    });
    $("vizZoomIn").addEventListener("click", () => view.zoom(0.6));
    $("vizZoomOut").addEventListener("click", () => view.zoom(1.6));
    $("vizFit").addEventListener("click", () => view.fit());

    // ---------------------------------------------------------- campos
    const scope = bindSegmented($("silScope"), (v) => {
      prefs.scope = v;
      save();
      renderTracks();
      invalidate("Fonte alterada — analise de novo.");
    });
    scope.set(prefs.scope);

    els.threshold.value = prefs.thresholdDb;
    els.auto.checked = prefs.autoDb;
    els.threshold.disabled = prefs.autoDb;
    els.minSilence.value = prefs.minSilenceSec;
    els.windowMs.value = prefs.windowMs;
    els.marginAfter.value = prefs.marginAfterMs;
    els.marginBefore.value = prefs.marginBeforeMs;
    els.backup.checked = prefs.backup;

    const live = debounce(() => redetect(), 90);
    const param = (key) => (v) => {
      prefs[key] = v;
      save();
      live();
    };
    bindNumber(els.threshold, param("thresholdDb"));
    bindNumber(els.minSilence, param("minSilenceSec"));
    bindNumber(els.windowMs, param("windowMs"));
    bindNumber(els.marginAfter, param("marginAfterMs"));
    bindNumber(els.marginBefore, param("marginBeforeMs"));
    els.auto.addEventListener("change", () => {
      prefs.autoDb = els.auto.checked;
      els.threshold.disabled = prefs.autoDb;
      save();
      redetect();
    });
    els.backup.addEventListener("change", () => {
      prefs.backup = els.backup.checked;
      save();
    });

    function save() {
      AEStore.savePrefs("silence", prefs);
    }

    els.summary.addEventListener("click", () => {
      if (!state.result) return;
      state.expanded = !state.expanded;
      renderPreview();
    });

    // ---------------------------------------------------------- faixas
    function chosenTracks() {
      const seq = state.info && state.info.sequence;
      if (!seq) return [];
      const set = state.tracksBySeq[seq.id];
      const tracks = state.info.audioTracks;
      if (set) return tracks.filter((t) => set.has(t.index)).map((t) => t.index);
      if (prefs.scope === "selection") return tracks.filter((t) => t.selected > 0).map((t) => t.index);
      // Só a primeira faixa com clipes (normalmente o diálogo): trilha musical
      // na análise faria nenhum silêncio ser encontrado.
      const first = tracks.find((t) => t.clips > 0 && !t.muted);
      return first ? [first.index] : [];
    }

    function renderTracks() {
      const info = state.info;
      els.tracks.innerHTML = "";
      if (!info || !info.sequence) {
        els.tracks.innerHTML = '<span class="hint">Abra uma sequência na Timeline.</span>';
        return;
      }
      const chosen = new Set(chosenTracks());
      info.audioTracks.forEach((t) => {
        const label = document.createElement("label");
        const count = prefs.scope === "selection" ? t.selected : t.clips;
        label.className = "track-chip" + (chosen.has(t.index) ? " track-chip--on" : "") + (count ? "" : " track-chip--empty");
        label.title = `${t.name}${t.muted ? " (mudo)" : ""}${t.locked ? " (travada)" : ""}`;
        const extra = [t.muted ? "mudo" : "", t.locked ? "travada" : ""].filter(Boolean).join(" · ");
        label.innerHTML = `<input type="checkbox" ${chosen.has(t.index) ? "checked" : ""} /> A${t.index + 1}<span class="tag">${count}${prefs.scope === "selection" ? " sel." : ""}${extra ? " · " + extra : ""}</span>`;
        label.querySelector("input").addEventListener("change", (e) => {
          const set = new Set(chosenTracks());
          if (e.target.checked) set.add(t.index);
          else set.delete(t.index);
          state.tracksBySeq[info.sequence.id] = set;
          renderTracks();
          invalidate("Faixas alteradas — analise de novo.");
        });
        els.tracks.appendChild(label);
      });
      els.scopeHint.textContent =
        prefs.scope === "selection"
          ? "Só os trechos dos clipes selecionados são analisados e cortados. O corte remove o trecho de todas as faixas destravadas, para manter o sincronismo."
          : "Marque só as faixas de voz (trilha musical impede achar silêncios). O corte é aplicado em todas as faixas destravadas, vídeo e áudio, para manter o sincronismo — trave uma faixa para protegê-la.";
    }

    // ---------------------------------------------------------- análise
    function setBusy(b, label) {
      state.busy = b;
      els.analyze.disabled = b;
      els.apply.disabled = b || !enabledCuts().length;
      els.progress.hidden = !b;
      if (!b) els.progressBar.style.width = "0";
      if (label) els.analyze.textContent = label;
    }

    function progress(frac) {
      els.progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    }

    function invalidate(msg) {
      if (!state.analysis) return;
      state.analysis = null;
      state.result = null;
      view.clear();
      renderPreview();
      els.apply.disabled = true;
      if (msg) setStatus(els.status, msg, "warn");
    }

    async function analyze() {
      if (state.busy) return;
      setBusy(true, "Analisando…");
      setStatus(els.status, "Lendo a timeline…");
      const opened = new Map();
      try {
        const info = await app.refreshInfo();
        const seq = info && info.sequence;
        if (!seq) throw new Error("Nenhuma sequência aberta na Timeline.");
        const tracks = chosenTracks();
        if (!tracks.length) throw new Error(prefs.scope === "selection" ? "Selecione clipes de áudio na Timeline." : "Escolha pelo menos uma faixa de áudio.");

        const selectedOnly = prefs.scope === "selection";
        const { clips: all } = await AEHost.call("audioClips", { seqId: seq.id, tracks, selectedOnly });
        const clips = all.filter((c) => !c.disabled);
        if (!clips.length) throw new Error(selectedOnly ? "Nenhum clipe de áudio selecionado nas faixas escolhidas." : "As faixas escolhidas não têm clipes de áudio.");

        const totalSec = clips.reduce((n, c) => n + (c.end - c.start) / TPS, 0);
        let doneSec = 0;
        const items = [];
        const issues = [];

        for (let i = 0; i < clips.length; i++) {
          const c = clips[i];
          const tStart = c.start / TPS;
          const tEnd = c.end / TPS;
          const dur = tEnd - tStart;
          const speed = c.speed || 1;
          const srcIn = c.inPoint / TPS;
          setStatus(els.status, `Lendo áudio ${i + 1} de ${clips.length}: ${c.name}`);
          try {
            if (c.reversed) throw new Error("clipe com velocidade invertida");
            if (!c.path) throw new Error("clipe sem arquivo de mídia (gerado, aninhado ou offline)");
            let media = opened.get(c.path);
            if (!media) {
              media = AEContainers.openMedia(c.path);
              opened.set(c.path, media);
            }
            const env = await AELevels.mediaEnvelope(media, srcIn, srcIn + dur * speed, AEDecode.decode, (f) => progress((doneSec + f * dur) / totalSec));
            items.push({ tStart, tEnd, srcIn, speed, env });
          } catch (err) {
            issues.push({ name: c.name, track: c.track, at: tStart, message: err.message });
            items.push({ tStart, tEnd, keep: true });
          }
          doneSec += dur;
          progress(doneSec / totalSec);
        }

        const from = Math.min(...items.map((x) => x.tStart));
        const to = Math.max(...items.map((x) => x.tEnd));
        const tl = AESilence.buildTimeline(items, from, to);
        const allowed = selectedOnly ? mergeRanges(clips.map((c) => ({ startSec: c.start / TPS, endSec: c.end / TPS }))) : null;
        const clipEdges = Array.from(new Set(clips.map((c) => c.start / TPS))).sort((a, b) => a - b);

        state.analysis = { seqId: seq.id, seqName: seq.name, seqEnd: seq.end, fps: seq.fps, timebase: seq.timebase, tl, allowed, clipEdges, issues };
        state.expanded = true;
        state.focus = -1;
        redetect(false);
        renderIssues();
        const n = state.result.cuts.length;
        setStatus(els.status, n ? `${n} silêncio(s) encontrado(s). Ajuste os parâmetros: a prévia atualiza na hora.` : "Nenhum silêncio com esses parâmetros.", n ? "success" : null);
      } catch (err) {
        console.error(err);
        setStatus(els.status, err.message, "error");
      } finally {
        opened.forEach((m) => m.src.close());
        setBusy(false, "Analisar Áudio");
      }
    }

    function mergeRanges(ranges) {
      const r = ranges.slice().sort((a, b) => a.startSec - b.startSec);
      const out = [];
      for (const x of r) {
        const last = out[out.length - 1];
        if (last && x.startSec <= last.endSec + 1e-6) last.endSec = Math.max(last.endSec, x.endSec);
        else out.push({ ...x });
      }
      return out;
    }

    function redetect(keepView = true) {
      const a = state.analysis;
      if (!a) return;
      let thresholdDb = prefs.thresholdDb;
      if (prefs.autoDb) {
        const s = AESilence.suggestThresholdDb(a.tl, prefs.windowMs);
        thresholdDb = s.thresholdDb;
        els.threshold.value = thresholdDb;
        els.autoHint.hidden = false;
        els.autoHint.innerHTML =
          s.noiseDb == null
            ? "Áudio curto demais para sugerir — usando −40 dB."
            : `Sugerido: <strong>${thresholdDb} dB</strong> (ruído de fundo ≈ ${Math.round(s.noiseDb)} dB, fala ≈ ${Math.round(s.speechDb)} dB).`;
      } else {
        els.autoHint.hidden = true;
      }
      const res = AESilence.detect(a.tl, {
        thresholdDb,
        windowMs: prefs.windowMs,
        minSilenceSec: prefs.minSilenceSec,
        marginAfterMs: prefs.marginAfterMs,
        marginBeforeMs: prefs.marginBeforeMs,
        fps: a.fps,
        allowed: a.allowed,
      });
      const levels = AESilence.windowLevels(a.tl, prefs.windowMs);
      state.result = { cuts: res.cuts.map((c) => ({ ...c, enabled: true })), thresholdDb, levels };
      state.focus = -1;
      view.setData(
        { startSec: a.tl.startSec, endSec: a.tl.endSec, levels, cuts: state.result.cuts, thresholdDb, clipEdges: a.clipEdges, allowed: a.allowed },
        keepView
      );
      renderPreview();
      els.apply.disabled = state.busy || !enabledCuts().length;
    }

    function enabledCuts() {
      return state.result ? state.result.cuts.filter((c) => c.enabled) : [];
    }

    // ---------------------------------------------------------- prévia
    function renderPreview() {
      const r = state.result;
      els.summary.disabled = !r;
      els.chevron.hidden = !r;
      if (!r) {
        els.summaryText.innerHTML = 'Clique em <b style="color:var(--text)">Analisar Áudio</b> para ler a timeline.';
        els.expanded.hidden = true;
        els.summary.setAttribute("aria-expanded", "false");
        return;
      }
      const on = enabledCuts();
      const total = on.reduce((n, c) => n + c.durationSec, 0);
      const off = r.cuts.length - on.length;
      els.summaryText.innerHTML = r.cuts.length
        ? `<b>${on.length}</b> corte(s) · <b>${formatDuration(total)}</b> a menos${off ? ` · ${off} desligado(s)` : ""}`
        : "Nenhum silêncio encontrado com esses parâmetros";
      els.chevron.classList.toggle("chevron--open", state.expanded);
      els.summary.setAttribute("aria-expanded", String(state.expanded));
      els.expanded.hidden = !state.expanded;

      const seqSec = (state.analysis.seqEnd || 0) / TPS || state.analysis.tl.endSec;
      const pct = seqSec ? Math.min(100, (total / seqSec) * 100) : 0;
      els.ratioKeep.style.width = `${100 - pct}%`;
      els.ratioCut.style.width = `${pct}%`;
      els.ratioFrom.textContent = `Sequência: ${formatTime(seqSec).replace(/\.\d+$/, "")} → ${formatTime(Math.max(0, seqSec - total)).replace(/\.\d+$/, "")}`;
      els.ratioTo.textContent = `−${pct.toFixed(1).replace(".", ",")}%`;

      if (state.expanded) renderCutsList();
    }

    function renderCutsList() {
      const r = state.result;
      els.cutsList.innerHTML = "";
      els.cutsList.hidden = !r.cuts.length;
      const frag = document.createDocumentFragment();
      r.cuts.forEach((c, i) => {
        const row = document.createElement("div");
        row.className = "cut-row" + (c.enabled ? "" : " cut-row--off") + (i === state.focus ? " cut-row--focus" : "");
        row.innerHTML = `<input type="checkbox" ${c.enabled ? "checked" : ""} aria-label="Incluir corte ${i + 1}" /><span class="cut-idx">${String(i + 1).padStart(2, "0")}</span><span class="cut-time">${formatTime(c.startSec)} → ${formatTime(c.endSec)}</span><span class="cut-dur">${formatDuration(c.durationSec)}</span>`;
        row.querySelector("input").addEventListener("click", (e) => {
          e.stopPropagation();
          toggleCut(i);
        });
        row.addEventListener("click", () => focusCut(i));
        frag.appendChild(row);
      });
      els.cutsList.appendChild(frag);
    }

    function toggleCut(i) {
      const c = state.result && state.result.cuts[i];
      if (!c) return;
      c.enabled = !c.enabled;
      view.render();
      renderPreview();
      els.apply.disabled = state.busy || !enabledCuts().length;
    }

    function focusCut(i) {
      const c = state.result.cuts[i];
      state.focus = i;
      view.setFocus(i);
      view.focusRange(c.startSec, c.endSec);
      renderCutsList();
      seek(c.startSec);
    }

    function renderIssues() {
      const a = state.analysis;
      if (!a || !a.issues.length) {
        els.notice.hidden = true;
        return;
      }
      const items = a.issues.slice(0, 6).map((x) => `<li>A${x.track + 1} · ${escapeHtml(x.name)} (${formatTime(x.at)}): ${escapeHtml(x.message)}</li>`).join("");
      const more = a.issues.length > 6 ? `<li>… e mais ${a.issues.length - 6}</li>` : "";
      els.notice.innerHTML = `<strong>${a.issues.length} clipe(s) não puderam ser lidos</strong> — esses trechos são tratados como fala e não serão cortados:<ul>${items}${more}</ul>`;
      els.notice.hidden = false;
    }

    async function seek(sec) {
      const a = state.analysis;
      if (!a) return;
      try {
        await AEHost.call("seek", { seqId: a.seqId, ticks: Math.round(sec * TPS) });
        view.setPlayhead(sec);
      } catch (err) {
        setStatus(els.status, err.message, "error");
      }
    }

    // ---------------------------------------------------------- aplicar
    async function apply() {
      const a = state.analysis;
      const cuts = enabledCuts();
      if (!a || !cuts.length || state.busy) return;

      const info = await app.refreshInfo();
      if (!info.sequence || info.sequence.id !== a.seqId) {
        setStatus(els.status, `Volte para a sequência "${a.seqName}" para aplicar.`, "error");
        return;
      }
      if (info.sequence.end !== a.seqEnd) {
        invalidate();
        setStatus(els.status, "A sequência mudou desde a análise. Analise de novo antes de cortar.", "error");
        return;
      }
      const total = cuts.reduce((n, c) => n + c.durationSec, 0);
      const locked = info.audioTracks.filter((t) => t.locked).length + (info.sequence.lockedVideoTracks || 0);
      const ok = await confirmDialog(
        `Aplicar ${cuts.length} corte(s)?`,
        `Remove ${formatDuration(total)} de "${a.seqName}" em todas as faixas destravadas.` +
          (locked ? ` Atenção: ${locked} faixa(s) travada(s) não serão cortadas e podem sair de sincronia.` : "") +
          (prefs.backup ? " Um backup da sequência será criado antes." : " Sem backup: para voltar, use Editar › Desfazer (um passo por corte)."),
        "Aplicar Cortes"
      );
      if (!ok) return;

      setBusy(true, "Aplicando…");
      els.apply.disabled = true;
      try {
        const tb = a.timebase;
        const payload = cuts.map((c, i) => ({ start: c.startFrame * tb, end: c.endFrame * tb, label: `Silêncio ${i + 1} (${formatDuration(c.durationSec)})` }));

        setStatus(els.status, "Criando marcadores de segurança…");
        const { guids } = await AEHost.call("markCuts", { seqId: a.seqId, cuts: payload });

        if (prefs.backup) {
          setStatus(els.status, "Criando backup da sequência…");
          const stamp = new Date().toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
          const b = await AEHost.call("backup", { seqId: a.seqId, name: `${a.seqName} (backup ${stamp})` });
          setStatus(els.status, `Backup criado: ${b.name}`);
        }

        // Do fim para o começo, em lotes, para mostrar progresso
        const order = payload.map((p, i) => ({ ...p, guid: guids[i], doneLabel: `Corte ${i + 1} (−${formatDuration(cuts[i].durationSec)})` })).reverse();
        const BATCH = 8;
        let failed = 0;
        for (let i = 0; i < order.length; i += BATCH) {
          setStatus(els.status, `Cortando… ${Math.min(order.length, i + BATCH)} de ${order.length}`);
          progress(i / order.length);
          const { results } = await AEHost.call("extractCuts", { seqId: a.seqId, cuts: order.slice(i, i + BATCH) });
          failed += results.filter((r) => !r.ok).length;
        }
        progress(1);

        const applied = order.length - failed;
        state.analysis = null;
        state.result = null;
        view.clear();
        renderPreview();
        els.notice.hidden = true;
        if (failed === 0) setStatus(els.status, `${applied} corte(s) aplicado(s) · ${formatDuration(total)} removidos.`, "success");
        else if (applied === 0) setStatus(els.status, "Nenhum corte foi aplicado. Os intervalos estão marcados em vermelho na sequência para corte manual.", "error");
        else setStatus(els.status, `${applied} de ${order.length} cortes aplicados. Os que falharam ficaram marcados em vermelho.`, "warn");
        app.refreshInfo();
      } catch (err) {
        console.error(err);
        setStatus(els.status, `Erro ao aplicar: ${err.message}. Os marcadores criados mostram os silêncios.`, "error");
      } finally {
        setBusy(false, "Analisar Áudio");
      }
    }

    els.analyze.addEventListener("click", analyze);
    els.apply.addEventListener("click", apply);

    // ---------------------------------------------------------- integração
    return {
      onInfo(info) {
        const prevSeq = state.info && state.info.sequence && state.info.sequence.id;
        state.info = info;
        renderTracks();
        const seqId = info && info.sequence && info.sequence.id;
        if (state.analysis && seqId !== state.analysis.seqId) {
          setStatus(els.status, `A análise é da sequência "${state.analysis.seqName}". Volte para ela para aplicar.`, "warn");
        } else if (prevSeq !== seqId && !state.analysis) {
          setStatus(els.status, "");
        }
        if (info && info.sequence && state.analysis && info.sequence.id === state.analysis.seqId) {
          view.setPlayhead(info.sequence.playhead / TPS);
        }
      },
      onPlayhead(ticks, seqId) {
        if (state.analysis && seqId === state.analysis.seqId && ticks != null) view.setPlayhead(ticks / TPS);
      },
      wantsPlayhead() {
        return !!(state.analysis && state.expanded && !state.busy);
      },
    };
  }

  root.AETools = root.AETools || {};
  root.AETools.silence = { mount };
})(window);
