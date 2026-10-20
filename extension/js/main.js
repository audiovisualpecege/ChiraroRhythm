/**
 * main.js — monta as abas e mantém o painel sincronizado com o Premiere.
 *
 * Para criar uma nova automação:
 *   1. index.html: nova <section class="tool-view" id="tool-<id>" data-tool-title="Nome">
 *   2. js/tools/<id>Tool.js: window.AETools.<id> = { mount(app) { return { onInfo, onShow } } }
 *   3. index.html: <script src="js/tools/<id>Tool.js"> antes do main.js
 */
(function () {
  const { $ } = AEUI;
  const TOOL_ORDER = ["silence", "zoom", "interleave", "sync"];

  const app = {
    info: null,
    tools: {},
    active: null,
    infoPromise: null,

    /** Lê a sequência ativa e as faixas; avisa todas as abas. */
    refreshInfo() {
      if (this.infoPromise) return this.infoPromise;
      this.infoPromise = AEHost.call("info")
        .then((info) => {
          this.info = info;
          renderSeqChip(info);
          Object.values(this.tools).forEach((t) => t.onInfo && t.onInfo(info));
          return info;
        })
        .catch((err) => {
          renderSeqChip(null, err.message);
          return this.info;
        })
        .finally(() => {
          this.infoPromise = null;
        });
      return this.infoPromise;
    },
  };

  function renderSeqChip(info, error) {
    const chip = $("seqChip");
    const name = $("seqName");
    const seq = info && info.sequence;
    chip.classList.toggle("seq-chip--none", !seq);
    name.textContent = seq ? seq.name : error || "Nenhuma sequência aberta";
    chip.title = seq ? `${seq.name} · ${seq.fps.toFixed(3).replace(/\.?0+$/, "")} fps` : name.textContent;
  }

  // ------------------------------------------------------------------ abas
  const strip = $("tabStrip");
  const sections = Array.from(document.querySelectorAll(".tool-view"));
  sections.forEach((section, i) => {
    const id = section.id.replace(/^tool-/, "");
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.dataset.tool = id;
    tab.textContent = section.dataset.toolTitle || id;
    tab.addEventListener("click", () => show(id));
    strip.appendChild(tab);
    if (i === 0) app.active = id;
  });

  function show(id) {
    app.active = id;
    strip.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.tool === id;
      t.classList.toggle("tab--active", on);
      t.setAttribute("aria-selected", String(on));
    });
    sections.forEach((s) => (s.hidden = s.id !== `tool-${id}`));
    const tool = app.tools[id];
    if (tool && tool.onShow) tool.onShow();
    try { localStorage.setItem("ae.activeTab", id); } catch (e) {}
  }

  TOOL_ORDER.forEach((id) => {
    if (window.AETools && window.AETools[id]) app.tools[id] = window.AETools[id].mount(app);
  });
  Object.keys(window.AETools || {}).forEach((id) => {
    if (!app.tools[id]) app.tools[id] = window.AETools[id].mount(app);
  });

  let saved = null;
  try { saved = localStorage.getItem("ae.activeTab"); } catch (e) {}
  show(saved && sections.some((s) => s.id === `tool-${saved}`) ? saved : app.active);

  // ------------------------------------------------------------ sincronia
  $("btnRefresh").addEventListener("click", () => app.refreshInfo());
  window.addEventListener("focus", () => app.refreshInfo());
  setInterval(() => {
    if (!document.hidden) app.refreshInfo();
  }, 3000);

  // Cursor do Premiere no visualizador (só enquanto a prévia está aberta)
  let polling = false;
  setInterval(async () => {
    const sil = app.tools.silence;
    if (polling || document.hidden || app.active !== "silence" || !sil || !sil.wantsPlayhead()) return;
    polling = true;
    try {
      const p = await AEHost.call("playhead");
      sil.onPlayhead(p.ticks, p.seqId);
    } catch (e) {
      /* ignora */
    } finally {
      polling = false;
    }
  }, 400);

  app.refreshInfo();
  if (window.AEUpdate) AEUpdate.mount($("btnUpdate"), $("updateNote"));
  window.AEApp = app;
})();
