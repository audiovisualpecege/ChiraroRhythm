/**
 * timelineView.js — visualizador da timeline do Cortador de Silêncios.
 *
 *   ┌ visão geral (sequência inteira + janela visível) ┐
 *   ├ nível em dB por janela de análise, limiar, cortes ┤
 *   └ régua de tempo                                    ┘
 *
 * O nível desenhado é o MESMO que a detecção usa (média por janela de
 * análise), então o que fica abaixo da linha tracejada é exatamente o que
 * vira corte (respeitando duração mínima e margens).
 */
(function (root) {
  const DB_MIN = -72;
  const DB_MAX = 0;
  const H_OVERVIEW = 22;
  const H_GAP = 5;
  const H_MAIN = 108;
  const H_RULER = 18;
  const HEIGHT = H_OVERVIEW + H_GAP + H_MAIN + H_RULER;
  const COLORS = {
    // Design System Chiaro (tema Noite) — ver css/style.css
    wave: "#8F8AA0",
    waveCut: "#8C4EDB",
    cutFill: "rgba(140,78,219,0.2)",
    cutEdge: "rgba(159,104,227,0.9)",
    cutOff: "rgba(185,177,204,0.55)",
    threshold: "#FACE95",
    grid: "rgba(255,255,255,0.05)",
    gridText: "rgba(255,255,255,0.28)",
    ruler: "#857C9C",
    playhead: "#FFFFFF",
    viewport: "rgba(255,255,255,0.7)",
    outside: "rgba(7,0,16,0.5)",
    clipEdge: "rgba(255,255,255,0.22)",
    hover: "rgba(255,255,255,0.35)",
  };
  const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

  class TimelineView {
    constructor({ canvas, wrap, tooltip, onSeek, onToggleCut }) {
      this.canvas = canvas;
      this.wrap = wrap;
      this.tooltip = tooltip;
      this.onSeek = onSeek;
      this.onToggleCut = onToggleCut;
      this.ctx = canvas.getContext("2d");
      this.data = null;
      this.view = { start: 0, end: 1 };
      this.hoverX = null;
      this.playhead = null;
      this.focusIndex = -1;
      this.pending = false;

      canvas.style.height = HEIGHT + "px";
      new ResizeObserver(() => this.resize()).observe(wrap);
      this.bindEvents();
    }

    // ------------------------------------------------------------ dados
    /**
     * @param d { startSec, endSec, levels: {w, db}, cuts: [{startSec,endSec,enabled}], thresholdDb, clipEdges: [sec], allowed?: [{startSec,endSec}] }
     */
    setData(d, keepView) {
      const first = !this.data;
      this.data = d;
      this.buildPyramid();
      if (first || !keepView) this.fit(false);
      this.render();
    }

    clear() {
      this.data = null;
      this.render();
    }

    setPlayhead(sec) {
      if (sec === this.playhead) return;
      this.playhead = sec;
      this.render();
    }

    setFocus(index) {
      this.focusIndex = index;
      this.render();
    }

    /** Pirâmide de máximos sobre os dB por janela, para desenhar rápido em qualquer zoom. */
    buildPyramid() {
      const base = this.data.levels.db;
      const levels = [base];
      let cur = base;
      while (cur.length > 64) {
        const next = new Float32Array(Math.ceil(cur.length / 8));
        for (let i = 0; i < next.length; i++) {
          let m = -Infinity;
          const end = Math.min(cur.length, (i + 1) * 8);
          for (let j = i * 8; j < end; j++) if (cur[j] > m) m = cur[j];
          next[i] = m;
        }
        levels.push(next);
        cur = next;
      }
      this.pyramid = levels;
    }

    /** Máximo de dB no intervalo de janelas [a, b). */
    maxDb(a, b) {
      const p = this.pyramid;
      a = Math.max(0, a);
      b = Math.min(p[0].length, b);
      if (b <= a) return null;
      let level = 0;
      let scale = 1;
      while (level + 1 < p.length && (b - a) / (scale * 8) >= 2) {
        level++;
        scale *= 8;
      }
      const arr = p[level];
      let m = -Infinity;
      for (let i = Math.floor(a / scale); i < Math.ceil(b / scale); i++) if (arr[i] > m) m = arr[i];
      return m;
    }

    // ------------------------------------------------------------ view
    fit(redraw = true) {
      if (!this.data) return;
      this.view = { start: this.data.startSec, end: this.data.endSec };
      if (redraw) this.render();
    }

    zoom(factor, centerSec) {
      if (!this.data) return;
      const { start, end } = this.view;
      const c = centerSec == null ? (start + end) / 2 : centerSec;
      const full = this.data.endSec - this.data.startSec;
      const span = Math.min(full, Math.max(0.25, (end - start) * factor));
      const ratio = (c - start) / (end - start || 1);
      this.setView(c - span * ratio, c - span * ratio + span);
    }

    focusRange(s, e) {
      if (!this.data) return;
      const pad = Math.max(1.5, (e - s) * 1.5);
      const span = Math.max(e - s + pad * 2, 4);
      const c = (s + e) / 2;
      this.setView(c - span / 2, c + span / 2);
    }

    setView(s, e) {
      const d = this.data;
      const span = e - s;
      if (s < d.startSec) { s = d.startSec; e = s + span; }
      if (e > d.endSec) { e = d.endSec; s = Math.max(d.startSec, e - span); }
      this.view = { start: s, end: e };
      this.render();
    }

    xToSec(x) {
      return this.view.start + (x / this.width) * (this.view.end - this.view.start);
    }

    secToX(t) {
      return ((t - this.view.start) / (this.view.end - this.view.start)) * this.width;
    }

    // ------------------------------------------------------------ eventos
    bindEvents() {
      const c = this.canvas;
      let drag = null;

      const pos = (e) => {
        const r = c.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };

      c.addEventListener("mousedown", (e) => {
        if (!this.data) return;
        const p = pos(e);
        drag = { x: p.x, y: p.y, start: this.view.start, end: this.view.end, moved: false, overview: p.y < H_OVERVIEW + H_GAP / 2 };
        if (drag.overview) this.centerOverview(p.x);
      });
      window.addEventListener("mousemove", (e) => {
        if (!this.data) return;
        const p = pos(e);
        if (drag) {
          if (Math.abs(p.x - drag.x) > 3) drag.moved = true;
          if (drag.overview) this.centerOverview(p.x);
          else if (drag.moved) {
            const dt = ((p.x - drag.x) / this.width) * (drag.end - drag.start);
            this.setView(drag.start - dt, drag.end - dt);
          }
        }
        const inside = p.x >= 0 && p.x <= this.width && p.y >= 0 && p.y <= HEIGHT;
        this.hoverX = inside && p.y > H_OVERVIEW ? p.x : null;
        this.updateTooltip();
        this.render();
      });
      window.addEventListener("mouseup", (e) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (!d.moved && !d.overview && this.onSeek) this.onSeek(this.xToSec(pos(e).x));
      });
      c.addEventListener("mouseleave", () => {
        this.hoverX = null;
        this.updateTooltip();
        this.render();
      });
      c.addEventListener("dblclick", (e) => {
        if (!this.data || !this.onToggleCut) return;
        const t = this.xToSec(pos(e).x);
        const i = this.data.cuts.findIndex((k) => t >= k.startSec && t <= k.endSec);
        if (i >= 0) this.onToggleCut(i);
      });
      c.addEventListener(
        "wheel",
        (e) => {
          if (!this.data) return;
          e.preventDefault();
          const span = this.view.end - this.view.start;
          if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            const d = ((e.shiftKey ? e.deltaY : e.deltaX) / this.width) * span;
            this.setView(this.view.start + d, this.view.end + d);
          } else {
            this.zoom(e.deltaY > 0 ? 1.25 : 0.8, this.xToSec(pos(e).x));
          }
        },
        { passive: false }
      );
    }

    centerOverview(x) {
      const d = this.data;
      const t = d.startSec + (x / this.width) * (d.endSec - d.startSec);
      const span = this.view.end - this.view.start;
      this.setView(t - span / 2, t + span / 2);
    }

    updateTooltip() {
      const tip = this.tooltip;
      if (this.hoverX == null || !this.data) {
        tip.hidden = true;
        return;
      }
      const t = this.xToSec(this.hoverX);
      const lv = this.data.levels;
      const i = Math.floor(((t - this.data.startSec) * 1000) / lv.w);
      const db = lv.db[i];
      const cut = this.data.cuts.find((k) => t >= k.startSec && t <= k.endSec);
      tip.textContent = `${AEUI.formatTime(t)}  ${db != null && db > -100 ? db.toFixed(1) + " dB" : "—"}${cut ? (cut.enabled ? "  · corte" : "  · corte desligado") : ""}`;
      tip.hidden = false;
      const w = tip.offsetWidth;
      tip.style.left = Math.max(2, Math.min(this.width - w - 2, this.hoverX + 8)) + "px";
      tip.style.top = H_OVERVIEW + H_GAP + 4 + "px";
    }

    // ------------------------------------------------------------ desenho
    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.width = this.wrap.clientWidth || 300;
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(HEIGHT * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    }

    render() {
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        this.draw();
      });
    }

    dbToY(db) {
      const v = (Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN);
      return H_OVERVIEW + H_GAP + H_MAIN - v * H_MAIN;
    }

    draw() {
      const ctx = this.ctx;
      const W = this.width;
      ctx.clearRect(0, 0, W, HEIGHT);
      if (!this.data || !W) return;
      const d = this.data;
      const top = H_OVERVIEW + H_GAP;

      this.drawOverview();

      // grade de dB
      ctx.font = "9px " + getComputedStyle(document.body).fontFamily;
      ctx.textBaseline = "middle";
      for (const g of [-60, -40, -20]) {
        const y = Math.round(this.dbToY(g)) + 0.5;
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.fillStyle = COLORS.gridText;
        ctx.fillText(`${g}`, 3, y - 5);
      }

      // trechos fora da seleção
      if (d.allowed && d.allowed.length) {
        ctx.fillStyle = COLORS.outside;
        let cursor = this.view.start;
        const sorted = d.allowed.slice().sort((a, b) => a.startSec - b.startSec);
        for (const a of sorted) {
          if (a.startSec > cursor) ctx.fillRect(this.secToX(cursor), top, this.secToX(a.startSec) - this.secToX(cursor), H_MAIN);
          cursor = Math.max(cursor, a.endSec);
        }
        if (cursor < this.view.end) ctx.fillRect(this.secToX(cursor), top, W - this.secToX(cursor), H_MAIN);
      }

      // fundo dos cortes
      const visibleCuts = [];
      d.cuts.forEach((k, i) => {
        if (k.endSec < this.view.start || k.startSec > this.view.end) return;
        visibleCuts.push(i);
        if (!k.enabled) return;
        const x1 = this.secToX(k.startSec);
        const x2 = this.secToX(k.endSec);
        ctx.fillStyle = COLORS.cutFill;
        ctx.fillRect(x1, top, Math.max(1, x2 - x1), H_MAIN);
      });

      // nível (dB por janela)
      const lv = d.levels;
      const secPerWin = lv.w / 1000;
      const bottom = top + H_MAIN;
      let ci = 0;
      const enabledCuts = d.cuts.filter((k) => k.enabled);
      for (let x = 0; x < W; x++) {
        const t0 = this.xToSec(x);
        const t1 = this.xToSec(x + 1);
        const a = Math.floor((t0 - d.startSec) / secPerWin);
        const b = Math.max(a + 1, Math.ceil((t1 - d.startSec) / secPerWin));
        const db = this.maxDb(a, b);
        if (db == null || db <= DB_MIN) continue;
        const tm = (t0 + t1) / 2;
        while (ci < enabledCuts.length && enabledCuts[ci].endSec < tm) ci++;
        const inCut = ci < enabledCuts.length && tm >= enabledCuts[ci].startSec;
        ctx.fillStyle = inCut ? COLORS.waveCut : COLORS.wave;
        const y = this.dbToY(db);
        ctx.fillRect(x, y, 1, bottom - y);
      }

      // bordas dos cortes
      for (const i of visibleCuts) {
        const k = d.cuts[i];
        const x1 = Math.round(this.secToX(k.startSec)) + 0.5;
        const x2 = Math.round(this.secToX(k.endSec)) + 0.5;
        ctx.lineWidth = i === this.focusIndex ? 2 : 1;
        if (k.enabled) {
          ctx.setLineDash([]);
          ctx.strokeStyle = COLORS.cutEdge;
        } else {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = COLORS.cutOff;
        }
        ctx.beginPath();
        ctx.moveTo(x1, top);
        ctx.lineTo(x1, bottom);
        ctx.moveTo(x2, top);
        ctx.lineTo(x2, bottom);
        if (!k.enabled || i === this.focusIndex) {
          ctx.moveTo(x1, top + 0.5);
          ctx.lineTo(x2, top + 0.5);
          ctx.moveTo(x1, bottom - 0.5);
          ctx.lineTo(x2, bottom - 0.5);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1;

      // inícios de clipe
      ctx.strokeStyle = COLORS.clipEdge;
      ctx.beginPath();
      for (const t of d.clipEdges || []) {
        if (t < this.view.start || t > this.view.end) continue;
        const x = Math.round(this.secToX(t)) + 0.5;
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + 6);
      }
      ctx.stroke();

      // limiar
      const ty = Math.round(this.dbToY(d.thresholdDb)) + 0.5;
      ctx.strokeStyle = COLORS.threshold;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(W, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = `${Math.round(d.thresholdDb)} dB`;
      const lw = ctx.measureText(label).width + 8;
      ctx.fillStyle = "rgba(7,0,16,0.85)";
      ctx.fillRect(W - lw - 2, ty - 7, lw, 13);
      ctx.fillStyle = COLORS.threshold;
      ctx.fillText(label, W - lw + 2, ty);

      this.drawRuler();
      this.drawPlayheadAndHover();
    }

    drawOverview() {
      const ctx = this.ctx;
      const d = this.data;
      const W = this.width;
      const span = d.endSec - d.startSec;
      const lv = d.levels;
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(0, 0, W, H_OVERVIEW);
      const winPerPx = (span * 1000) / lv.w / W;
      for (let x = 0; x < W; x++) {
        const db = this.maxDb(Math.floor(x * winPerPx), Math.ceil((x + 1) * winPerPx));
        if (db == null || db <= DB_MIN) continue;
        const h = ((db - DB_MIN) / (DB_MAX - DB_MIN)) * (H_OVERVIEW - 4);
        ctx.fillStyle = "#47435A";
        ctx.fillRect(x, H_OVERVIEW - 2 - h, 1, h);
      }
      ctx.fillStyle = COLORS.waveCut;
      for (const k of d.cuts) {
        if (!k.enabled) continue;
        const x1 = ((k.startSec - d.startSec) / span) * W;
        const x2 = ((k.endSec - d.startSec) / span) * W;
        ctx.fillRect(x1, H_OVERVIEW - 4, Math.max(1, x2 - x1), 4);
      }
      const vx1 = ((this.view.start - d.startSec) / span) * W;
      const vx2 = ((this.view.end - d.startSec) / span) * W;
      ctx.strokeStyle = COLORS.viewport;
      ctx.strokeRect(Math.round(vx1) + 0.5, 0.5, Math.max(3, Math.round(vx2 - vx1)) - 1, H_OVERVIEW - 1);
      if (this.playhead != null) {
        ctx.fillStyle = COLORS.playhead;
        ctx.fillRect(((this.playhead - d.startSec) / span) * W, 0, 1, H_OVERVIEW);
      }
    }

    drawRuler() {
      const ctx = this.ctx;
      const W = this.width;
      const y0 = H_OVERVIEW + H_GAP + H_MAIN;
      const span = this.view.end - this.view.start;
      const step = RULER_STEPS.find((s) => (s / span) * W >= 70) || RULER_STEPS[RULER_STEPS.length - 1];
      ctx.strokeStyle = COLORS.ruler;
      ctx.fillStyle = COLORS.ruler;
      ctx.textBaseline = "top";
      ctx.beginPath();
      for (let t = Math.ceil(this.view.start / step) * step; t <= this.view.end; t += step) {
        const x = Math.round(this.secToX(t)) + 0.5;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + 4);
        const label = step < 1 ? AEUI.formatTime(t).replace(/^00:/, "") : AEUI.formatTime(t).replace(/\.\d+$/, "");
        ctx.fillText(label, x + 3, y0 + 4);
      }
      ctx.stroke();
    }

    drawPlayheadAndHover() {
      const ctx = this.ctx;
      const top = H_OVERVIEW + H_GAP;
      if (this.playhead != null && this.playhead >= this.view.start && this.playhead <= this.view.end) {
        const x = Math.round(this.secToX(this.playhead)) + 0.5;
        ctx.strokeStyle = COLORS.playhead;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + H_MAIN + H_RULER);
        ctx.stroke();
        ctx.fillStyle = COLORS.playhead;
        ctx.beginPath();
        ctx.moveTo(x - 4, top);
        ctx.lineTo(x + 4, top);
        ctx.lineTo(x, top + 5);
        ctx.fill();
      }
      if (this.hoverX != null) {
        ctx.strokeStyle = COLORS.hover;
        ctx.beginPath();
        ctx.moveTo(Math.round(this.hoverX) + 0.5, top);
        ctx.lineTo(Math.round(this.hoverX) + 0.5, top + H_MAIN);
        ctx.stroke();
      }
    }
  }

  root.AETimelineView = TimelineView;
})(window);
