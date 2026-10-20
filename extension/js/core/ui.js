/**
 * ui.js — utilidades de interface compartilhadas pelas abas.
 */
(function (root) {
  const TICKS_PER_SECOND = 254016000000;

  const $ = (id) => document.getElementById(id);

  function setStatus(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? ` status--${kind}` : "");
  }

  /** mm:ss.cc (ou h:mm:ss.cc) */
  function formatTime(sec) {
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = (sec % 60).toFixed(2).padStart(5, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
  }

  /** Duração curta: 340ms / 1,25s / 2:31 */
  function formatDuration(sec) {
    if (sec < 1) return `${Math.round(sec * 1000)}ms`;
    if (sec < 60) return `${sec.toFixed(2).replace(".", ",")}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** Timecode HH:MM:SS:FF (sem drop-frame, só para exibição). */
  function formatTimecode(sec, fps) {
    const f = Math.round(sec * fps);
    const fpsInt = Math.round(fps);
    const ff = f % fpsInt;
    const total = Math.floor(f / fpsInt);
    const ss = total % 60;
    const mm = Math.floor(total / 60) % 60;
    const hh = Math.floor(total / 3600);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
  }

  /** Campo numérico: aceita digitação livre, limita ao sair do campo. */
  function bindNumber(input, onChange) {
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    const read = () => {
      const v = Number(String(input.value).replace(",", "."));
      return Number.isFinite(v) ? v : null;
    };
    input.addEventListener("input", () => {
      const v = read();
      if (v != null && v >= min && v <= max) onChange(v);
    });
    input.addEventListener("change", () => {
      let v = read();
      if (v == null) v = Number(input.defaultValue);
      v = Math.min(max, Math.max(min, v));
      input.value = v;
      onChange(v);
    });
  }

  /** Grupo segmentado (botões com aria-pressed). */
  function bindSegmented(group, onChange) {
    const buttons = Array.from(group.querySelectorAll("button"));
    const set = (value) => {
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
    };
    buttons.forEach((b) =>
      b.addEventListener("click", () => {
        set(b.dataset.value);
        onChange(b.dataset.value);
      })
    );
    return { set, get: () => (buttons.find((b) => b.getAttribute("aria-pressed") === "true") || {}).dataset?.value };
  }

  /** Confirmação em modal (window.confirm trava o painel em algumas versões). */
  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const modal = $("modal");
      $("modalTitle").textContent = title;
      $("modalText").textContent = text;
      $("modalOk").textContent = okLabel || "Confirmar";
      modal.hidden = false;
      $("modalOk").focus();
      const done = (v) => {
        modal.hidden = true;
        $("modalOk").onclick = null;
        $("modalCancel").onclick = null;
        document.removeEventListener("keydown", onKey);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") done(false);
      };
      document.addEventListener("keydown", onKey);
      $("modalOk").onclick = () => done(true);
      $("modalCancel").onclick = () => done(false);
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  root.AEUI = { TICKS_PER_SECOND, $, setStatus, formatTime, formatDuration, formatTimecode, bindNumber, bindSegmented, confirmDialog, debounce, escapeHtml };
})(window);
