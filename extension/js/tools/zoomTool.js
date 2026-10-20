/**
 * zoomTool.js — Aba "Zoom": Alternador de Zoom.
 *
 * Cada clipe de vídeo é um corte. Ciclo 100% → zoom → (segunda escala) → …
 * aplicado num efeito Transformar "assinado" (ver host.jsx). Reaplicar
 * atualiza os efeitos do app; "Remover zoom" tira só os do app.
 * A prévia roda no painel, sobre um frame capturado do clipe selecionado.
 */
(function (root) {
  const { $, setStatus, bindNumber, bindSegmented, confirmDialog, debounce, escapeHtml } = AEUI;
  const path = require("path");
  const os = require("os");
  const fs = require("fs");

  const DEFAULTS = {
    scope: "track",
    track: 0,
    mainScale: 125,
    secondEnabled: false,
    secondScale: 115,
    startWithZoom: false,
    focusX: 50,
    focusY: 50,
    mode: "fixed",
    direction: "in",
    intensity: 3,
  };
  const ELIGIBLE = { video: true, image: true, nested: true };
  const KIND_LABEL = { graphic: "gráfico/texto", adjustment: "camada de ajuste" };

  function mount(app) {
    const prefs = AEStore.loadPrefs("zoom", DEFAULTS);
    const els = {
      track: $("zmTrack"),
      main: $("zmMain"),
      second: $("zmSecond"),
      secondOn: $("zmSecondOn"),
      startZoom: $("zmStartZoom"),
      cycle: $("zmCycle"),
      borderWarn: $("zmBorderWarn"),
      x: $("zmX"),
      y: $("zmY"),
      xOut: $("zmXOut"),
      yOut: $("zmYOut"),
      intensity: $("zmIntensity"),
      intensityHint: $("zmIntensityHint"),
      direction: $("zmDirection"),
      previewBtn: $("zmPreviewBtn"),
      previewBox: $("zmPreviewBox"),
      previewEmpty: $("zmPreviewEmpty"),
      canvas: $("zmCanvas"),
      badge: $("zmBadge"),
      pick: $("zmPick"),
      previewInfo: $("zmPreviewInfo"),
      seeInPremiere: $("zmSeeInPremiere"),
      summary: $("zmSummary"),
      apply: $("zmApply"),
      remove: $("zmRemove"),
      status: $("zmStatus"),
      progress: $("zmProgress"),
      progressBar: $("zmProgressBar"),
    };
    const state = {
      info: null,
      scopeData: null, // resposta de zoomClips para o escopo atual
      busy: false,
      preview: { open: false, clipId: null, img: null, info: null, pickIndex: null, anim: 0 },
    };

    // ---------------------------------------------------------- campos
    const scope = bindSegmented($("zmScope"), (v) => {
      prefs.scope = v;
      changed(true);
    });
    scope.set(prefs.scope);
    const mode = bindSegmented($("zmMode"), (v) => {
      prefs.mode = v;
      changed();
    });
    mode.set(prefs.mode);
    const direction = bindSegmented(els.direction, (v) => {
      prefs.direction = v;
      changed();
    });
    direction.set(prefs.direction);

    els.main.value = prefs.mainScale;
    els.second.value = prefs.secondScale;
    els.secondOn.checked = prefs.secondEnabled;
    els.startZoom.checked = prefs.startWithZoom;
    els.x.value = prefs.focusX;
    els.y.value = prefs.focusY;
    els.intensity.value = prefs.intensity;

    bindNumber(els.main, (v) => { prefs.mainScale = v; changed(); });
    bindNumber(els.second, (v) => { prefs.secondScale = v; changed(); });
    bindNumber(els.intensity, (v) => { prefs.intensity = v; changed(); });
    els.secondOn.addEventListener("change", () => { prefs.secondEnabled = els.secondOn.checked; changed(); });
    els.startZoom.addEventListener("change", () => { prefs.startWithZoom = els.startZoom.checked; changed(); });
    els.track.addEventListener("change", () => { prefs.track = Number(els.track.value); changed(true); });
    for (const [input, key] of [[els.x, "focusX"], [els.y, "focusY"]]) {
      input.addEventListener("input", () => { prefs[key] = Number(input.value); changed(); });
      input.addEventListener("dblclick", () => { input.value = 50; prefs[key] = 50; changed(); });
    }

    function settings() {
      return {
        mainScale: prefs.mainScale,
        secondEnabled: prefs.secondEnabled,
        secondScale: prefs.secondScale,
        startWithZoom: prefs.startWithZoom,
        focusX: prefs.focusX / 100,
        focusY: prefs.focusY / 100,
        mode: prefs.mode,
        direction: prefs.direction,
        intensity: prefs.intensity,
      };
    }

    const reloadScope = debounce(() => loadScope(), 200);

    /** Algo mudou: salva, redesenha controles, prévia e resumo. */
    function changed(scopeChanged) {
      AEStore.savePrefs("zoom", prefs);
      renderControls();
      drawPreview();
      if (scopeChanged) reloadScope();
      else renderSummary();
    }

    function renderControls() {
      const moving = prefs.mode === "moving";
      els.direction.querySelectorAll("button").forEach((b) => (b.disabled = !moving));
      els.intensity.disabled = !moving;
      els.second.disabled = !prefs.secondEnabled;
      els.track.disabled = prefs.scope !== "track";
      els.xOut.textContent = `${prefs.focusX}%`;
      els.yOut.textContent = `${prefs.focusY}%`;
      els.intensityHint.textContent = moving ? `Ex.: ${prefs.mainScale}% → ${fmt(prefs.mainScale + prefs.intensity)}% ao longo do clipe` : "Só no modo em movimento";

      const cycle = AEZoomPlan.cycleOf(settings());
      const offset = prefs.startWithZoom ? 1 : 0;
      const seq = [];
      for (let i = 0; i < Math.max(4, cycle.length + 1); i++) seq.push(cycle[(i + offset) % cycle.length]);
      els.cycle.innerHTML =
        seq.map((s, i) => `<span class="cycle-step${s !== 100 ? " cycle-step--zoom" : ""}" title="Clipe ${i + 1}">${i + 1}º · ${fmt(s)}%</span>`).join("<span>→</span>") + "<span>…</span>";
      els.borderWarn.hidden = !cycle.some((s) => s < 100);
    }

    const fmt = (n) => String(Math.round(n * 100) / 100).replace(".", ",");

    // ---------------------------------------------------------- faixas / escopo
    function renderTracks() {
      const info = state.info;
      els.track.innerHTML = "";
      if (!info || !info.sequence || !info.videoTracksInfo) {
        els.track.add(new Option("Sem sequência", ""));
        return;
      }
      info.videoTracksInfo.forEach((t) => {
        const label = `V${t.index + 1} · ${t.name} (${t.clips} clipe${t.clips === 1 ? "" : "s"})${t.locked ? " · travada" : ""}`;
        els.track.add(new Option(label, String(t.index), false, t.index === prefs.track));
      });
      if (!info.videoTracksInfo.some((t) => t.index === prefs.track)) {
        const first = info.videoTracksInfo.find((t) => t.clips > 0) || info.videoTracksInfo[0];
        if (first) {
          prefs.track = first.index;
          els.track.value = String(first.index);
        }
      }
    }

    async function loadScope() {
      const seq = state.info && state.info.sequence;
      if (!seq) {
        state.scopeData = null;
        renderSummary();
        return null;
      }
      try {
        const d = await AEHost.call("zoomClips", { seqId: seq.id, scope: prefs.scope, track: prefs.track });
        state.scopeData = { ...d, seqId: seq.id };
      } catch (err) {
        state.scopeData = { error: err.message };
      }
      renderSummary();
      return state.scopeData;
    }

    /** Separa elegíveis e pulados, por faixa. */
    function split(data) {
      const tracks = [];
      const skipped = { locked: 0, disabled: 0 };
      for (const t of data.tracks || []) {
        if (t.locked) {
          skipped.locked += t.clips.length;
          continue;
        }
        const clips = [];
        for (const c of t.clips) {
          if (c.disabled) skipped.disabled++;
          else if (!ELIGIBLE[c.kind]) skipped[c.kind] = (skipped[c.kind] || 0) + 1;
          else clips.push(c);
        }
        if (clips.length) tracks.push({ track: t.track, clips });
      }
      return { tracks, skipped };
    }

    function currentPlan() {
      if (!state.scopeData || !state.scopeData.tracks) return null;
      const { tracks, skipped } = split(state.scopeData);
      return { items: AEZoomPlan.plan(tracks, settings()), skipped, tracks };
    }

    function renderSummary() {
      const seq = state.info && state.info.sequence;
      els.apply.disabled = true;
      if (!seq) {
        els.summary.innerHTML = "<li>Abra uma sequência na Timeline.</li>";
        return;
      }
      if (state.scopeData && state.scopeData.error) {
        els.summary.innerHTML = `<li style="color:var(--danger)">${escapeHtml(state.scopeData.error)}</li>`;
        return;
      }
      const p = currentPlan();
      if (!p) {
        els.summary.innerHTML = "<li>Lendo os clipes…</li>";
        return;
      }
      if (!p.items.length) {
        const why = prefs.scope === "selected" ? "Selecione clipes de vídeo na Timeline." : "Nenhum clipe de vídeo elegível nesse escopo.";
        els.summary.innerHTML = `<li>${why}</li>${skippedHtml(p.skipped)}`;
        return;
      }
      const s = AEZoomPlan.summarize(p.items);
      const scales = Object.keys(s.byScale)
        .map(Number)
        .sort((a, b) => a - b)
        .map((k) => `${s.byScale[k]}× ${fmt(k)}%`)
        .join(" · ");
      const tracks = p.tracks.map((t) => `V${t.track + 1}`).join(", ");
      const updating = p.items.filter((it) => findClip(it.id)?.hasAppZoom).length;
      els.summary.innerHTML = `
        <li>Clipes que recebem o ciclo <b>${s.total}</b></li>
        <li>Faixas <b>${tracks}</b></li>
        <li>Escalas <b>${scales}</b></li>
        ${prefs.mode === "moving" ? `<li>Movimento <b>${{ in: "zoom in", out: "zoom out", alternate: "alternado" }[prefs.direction]} +${fmt(prefs.intensity)}%</b></li>` : ""}
        ${updating ? `<li>Já têm zoom do app (serão atualizados) <b>${updating}</b></li>` : ""}
        ${skippedHtml(p.skipped)}`;
      els.apply.disabled = state.busy;
    }

    function skippedHtml(sk) {
      const parts = [];
      for (const k of Object.keys(sk)) {
        if (!sk[k]) continue;
        const label = k === "locked" ? "em faixa travada" : k === "disabled" ? "desativados" : KIND_LABEL[k] || k;
        parts.push(`${sk[k]} ${label}`);
      }
      return parts.length ? `<li>Pulados <b>${parts.join(" · ")}</b></li>` : "";
    }

    function findClip(id) {
      for (const t of (state.scopeData && state.scopeData.tracks) || []) {
        const c = t.clips.find((x) => x.id === id);
        if (c) return c;
      }
      return null;
    }

    // ---------------------------------------------------------- aplicar / remover
    function setBusy(b) {
      state.busy = b;
      els.remove.disabled = b;
      els.seeInPremiere.disabled = b;
      els.progress.hidden = !b;
      if (!b) els.progressBar.style.width = "0";
      renderSummary();
    }

    async function apply() {
      const seq = state.info && state.info.sequence;
      if (!seq || state.busy) return;
      await loadScope();
      const p = currentPlan();
      if (!p || !p.items.length) return;
      const s = AEZoomPlan.summarize(p.items);
      const ok = await confirmDialog(
        `Aplicar zoom em ${s.total} clipe(s)?`,
        `Ciclo ${AEZoomPlan.cycleOf(settings()).map((v) => fmt(v) + "%").join(" → ")}${prefs.mode === "moving" ? `, em movimento (+${fmt(prefs.intensity)}%)` : ""}. ` +
          "O zoom vai num efeito Transformar próprio do app; seus efeitos e o Movimento dos clipes não são alterados. Clipes que já têm zoom do app são atualizados.",
        "Aplicar Zoom"
      );
      if (!ok) return;
      setBusy(true);
      setStatus(els.status, "Aplicando zoom…");
      try {
        const items = p.items.map((it) => ({ id: it.id, needsEffect: it.needsEffect, moving: it.moving, scaleStart: it.scaleStart, scaleEnd: it.scaleEnd, posStart: it.posStart, posEnd: it.posEnd }));
        const BATCH = 20;
        const results = [];
        for (let i = 0; i < items.length; i += BATCH) {
          els.progressBar.style.width = `${Math.round((i / items.length) * 100)}%`;
          setStatus(els.status, `Aplicando zoom… ${Math.min(items.length, i + BATCH)} de ${items.length}`);
          const r = await AEHost.call("zoomApply", { seqId: seq.id, items: items.slice(i, i + BATCH) });
          results.push(...r.results);
        }
        const failed = results.filter((r) => !r.ok);
        const count = (a) => results.filter((r) => r.ok && r.action === a).length;
        const msg = [`${count("aplicado")} aplicado(s)`, `${count("atualizado")} atualizado(s)`];
        if (count("removido (100%)")) msg.push(`${count("removido (100%)")} voltaram a 100%`);
        if (failed.length) setStatus(els.status, `${msg.join(", ")}; ${failed.length} com erro: ${failed[0].error}`, "warn");
        else setStatus(els.status, `Pronto: ${msg.join(", ")}.`, "success");
      } catch (err) {
        setStatus(els.status, `Erro: ${err.message}`, "error");
      } finally {
        setBusy(false);
        loadScope();
      }
    }

    async function removeZoom() {
      const seq = state.info && state.info.sequence;
      if (!seq || state.busy) return;
      const d = await loadScope();
      const ids = [];
      for (const t of (d && d.tracks) || []) for (const c of t.clips) if (c.hasAppZoom) ids.push(c.id);
      if (!ids.length) {
        setStatus(els.status, "Nenhum clipe com zoom do app nesse escopo.");
        return;
      }
      const where = prefs.scope === "selected" ? "dos clipes selecionados" : prefs.scope === "track" ? `da faixa V${prefs.track + 1}` : "de todas as faixas";
      const ok = await confirmDialog(`Remover zoom de ${ids.length} clipe(s)?`, `Tira o Transformar do app ${where}. Transformar adicionados por você não são tocados.`, "Remover zoom");
      if (!ok) return;
      setBusy(true);
      try {
        const r = await AEHost.call("zoomRemove", { seqId: seq.id, ids });
        if (r.errors.length) setStatus(els.status, `${r.removed} removido(s); ${r.errors.length} com erro: ${r.errors[0]}`, "warn");
        else setStatus(els.status, `Zoom removido de ${r.removed} clipe(s).`, "success");
      } catch (err) {
        setStatus(els.status, `Erro: ${err.message}`, "error");
      } finally {
        setBusy(false);
        loadScope();
      }
    }

    els.apply.addEventListener("click", apply);
    els.remove.addEventListener("click", removeZoom);

    // ---------------------------------------------------------- prévia
    const tmpBase = path.join(os.tmpdir(), "AutomacaoEdicao", "previa-zoom");
    try { fs.mkdirSync(path.dirname(tmpBase), { recursive: true }); } catch (e) { /* já existe */ }

    els.previewBtn.addEventListener("click", () => {
      if (state.preview.open) closePreview();
      else openPreview();
    });

    function closePreview() {
      state.preview.open = false;
      state.preview.clipId = null;
      state.preview.img = null;
      cancelAnimationFrame(state.preview.anim);
      els.previewBox.hidden = true;
      els.previewEmpty.hidden = false;
      els.previewBtn.textContent = "Mostrar prévia";
    }

    async function openPreview() {
      const sel = state.info && state.info.selectedVideo;
      if (!sel) {
        setStatus(els.status, "Selecione um clipe de vídeo na Timeline para a prévia.", "warn");
        return;
      }
      state.preview.open = true;
      els.previewBtn.textContent = "Fechar prévia";
      await capture(sel.id);
    }

    async function capture(clipId) {
      const seq = state.info && state.info.sequence;
      if (!seq) return;
      state.preview.clipId = clipId;
      els.previewInfo.textContent = "Capturando frame…";
      try {
        const r = await AEHost.call("zoomCapture", { seqId: seq.id, id: clipId, path: tmpBase });
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error("não consegui abrir o frame capturado"));
          img.src = (r.url || "file:///" + r.file.replace(/\\/g, "/")) + "?t=" + Date.now();
        });
        if (state.preview.clipId !== clipId) return; // seleção mudou no meio
        state.preview.img = img;
        state.preview.info = r;
        state.preview.pickIndex = null;
        els.previewBox.hidden = false;
        els.previewEmpty.hidden = true;
        drawPreview();
      } catch (err) {
        els.previewInfo.textContent = err.message;
      }
    }

    /** Escala (do ciclo) que o clipe da prévia recebe no plano atual. */
    function previewTarget() {
      const p = currentPlan();
      const id = state.preview.clipId;
      const item = p && p.items.find((it) => it.id === id);
      const cycle = AEZoomPlan.cycleOf(settings());
      let idx = state.preview.pickIndex;
      if (idx == null || idx >= cycle.length) {
        idx = item ? cycle.indexOf(item.scale) : 1;
        if (idx < 0) idx = 1;
      }
      return { item, cycle, idx, scale: cycle[idx], clipIndex: item ? item.index : null };
    }

    function itemForScale(scale, clipIndex) {
      const s = settings();
      const one = AEZoomPlan.plan([{ track: 0, clips: [{ id: "x", start: 0 }] }], { ...s, mainScale: scale, secondEnabled: false, startWithZoom: true })[0];
      // direção "alternar" segue a posição do clipe no ciclo
      if (s.mode === "moving" && s.direction === "alternate" && clipIndex != null && clipIndex % 2 === 1) {
        return AEZoomPlan.plan([{ track: 0, clips: [{ id: "x", start: 0 }] }], { ...s, mainScale: scale, secondEnabled: false, startWithZoom: true, direction: "out" })[0];
      }
      return one;
    }

    function drawPreview() {
      const pv = state.preview;
      cancelAnimationFrame(pv.anim);
      if (!pv.open || !pv.img) return;
      const t = previewTarget();
      els.pick.innerHTML = t.cycle
        .map((s, i) => `<button type="button" class="cycle-step" data-i="${i}" aria-pressed="${i === t.idx}">${fmt(s)}%</button>`)
        .join("");
      els.pick.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          pv.pickIndex = Number(b.dataset.i);
          drawPreview();
        })
      );
      const name = pv.info ? pv.info.name : "";
      els.previewInfo.textContent = t.item
        ? `${name} · ${t.clipIndex + 1}º clipe da V${t.item.track + 1} → recebe ${fmt(t.item.scale)}%`
        : `${name} · fora do escopo atual (mostrando ${fmt(t.scale)}%)`;

      const it = itemForScale(t.scale, t.clipIndex);
      const canvas = els.canvas;
      const W = canvas.parentElement.clientWidth || 340;
      const H = Math.round((W * pv.info.height) / pv.info.width);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = "high";

      const frame = (scale) => {
        const s = scale / 100;
        const pos = AEZoomPlan.positionFor(scale, prefs.focusX / 100, prefs.focusY / 100);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(pv.img, (pos[0] - 0.5 * s) * W, (pos[1] - 0.5 * s) * H, s * W, s * H);
        // mira
        const fx = (prefs.focusX / 100) * W;
        const fy = (prefs.focusY / 100) * H;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(fx - 7, fy);
        ctx.lineTo(fx + 7, fy);
        ctx.moveTo(fx, fy - 7);
        ctx.lineTo(fx, fy + 7);
        ctx.stroke();
        els.badge.textContent = `${fmt(scale)}%`;
      };

      if (!it.moving) {
        frame(it.scaleStart);
        return;
      }
      const DURATION = 2400;
      const t0 = performance.now();
      const tick = (now) => {
        const k = ((now - t0) % DURATION) / DURATION;
        frame(it.scaleStart + (it.scaleEnd - it.scaleStart) * k);
        pv.anim = requestAnimationFrame(tick);
      };
      pv.anim = requestAnimationFrame(tick);
    }

    // "Ver no Premiere": aplica de verdade só no clipe da prévia
    els.seeInPremiere.addEventListener("click", async () => {
      const seq = state.info && state.info.sequence;
      const pv = state.preview;
      if (!seq || !pv.clipId || state.busy) return;
      const t = previewTarget();
      const it = itemForScale(t.scale, t.clipIndex);
      try {
        const r = await AEHost.call("zoomApply", { seqId: seq.id, items: [{ id: pv.clipId, needsEffect: it.needsEffect, moving: it.moving, scaleStart: it.scaleStart, scaleEnd: it.scaleEnd, posStart: it.posStart, posEnd: it.posEnd }] });
        const res = r.results[0];
        if (!res.ok) throw new Error(res.error);
        if (pv.info) AEHost.call("seek", { seqId: seq.id, ticks: pv.info.ticks }).catch(() => {});
        setStatus(els.status, `Aplicado em "${pv.info ? pv.info.name : "clipe"}" (${fmt(t.scale)}%). Dê play no Premiere para conferir.`, "success");
        loadScope();
      } catch (err) {
        setStatus(els.status, `Erro: ${err.message}`, "error");
      }
    });

    new ResizeObserver(() => drawPreview()).observe(els.previewBox);

    renderControls();

    return {
      onInfo(info) {
        const before = JSON.stringify(state.info && { s: state.info.sequence && state.info.sequence.id, v: state.info.videoTracksInfo });
        state.info = info;
        const after = JSON.stringify(info && { s: info.sequence && info.sequence.id, v: info.videoTracksInfo });
        if (before !== after) {
          renderTracks();
          if (!state.busy) loadScope();
        }
        // prévia ao vivo: acompanha o clipe selecionado
        const sel = info && info.selectedVideo;
        if (state.preview.open && sel && sel.id !== state.preview.clipId && !state.busy) capture(sel.id);
      },
      onShow() {
        if (!state.busy) loadScope();
      },
    };
  }

  root.AETools = root.AETools || {};
  root.AETools.zoom = { mount };
})(window);
