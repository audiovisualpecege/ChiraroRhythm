/**
 * updater.js — botão "Atualizar" do cabeçalho.
 *  - ao abrir o painel, consulta o último Release do GitHub (sem internet: silêncio);
 *  - versão mais nova → botão "Atualizar para X" (notas no title);
 *  - clique → baixa o Rhythm-<v>.exe (progresso no botão) e dispara o instalador em
 *    modo /aguardar: ele espera o Premiere fechar, instala sozinho e oferece reabrir.
 * Modo de teste: localStorage "rhythm.updateUrl" troca a consulta do GitHub por outra
 * URL com a mesma resposta (servidor local do banco de prova).
 */
(function (root) {
  const REPO = "audiovisualpecege/ChiraroRhythm";
  const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
  const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

  // ---------------------------------------------------------------- lógica pura
  function parseVersion(v) {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(v || "").trim());
    return m ? [+m[1], +(m[2] || 0), +(m[3] || 0)] : null;
  }

  function compareVersions(a, b) {
    const x = parseVersion(a), y = parseVersion(b);
    if (!x || !y) return 0;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  }

  /** "3.0.0" → "3.0"; "3.0.1" → "3.0.1" (mesmo padrão do nome do instalador) */
  function shortVersion(v) {
    const p = parseVersion(v);
    if (!p) return String(v);
    return p[2] ? p.join(".") : `${p[0]}.${p[1]}`;
  }

  /** Resposta da API de Releases → atualização disponível (ou null). */
  function pickUpdate(release, current) {
    if (!release || release.draft || release.prerelease) return null;
    const version = String(release.tag_name || "").replace(/^v/, "");
    if (!parseVersion(version) || compareVersions(version, current) <= 0) return null;
    const asset = (release.assets || []).find((a) => /^Rhythm-[\d.]+\.exe$/i.test(a.name || ""));
    if (!asset || !asset.browser_download_url) return null;
    return {
      version,
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size || 0,
      notes: String(release.body || "").trim(),
      page: release.html_url || RELEASES_PAGE,
    };
  }

  // ---------------------------------------------------------------- Node (CEP)
  let fs, path, os, cp;
  try { fs = require("fs"); path = require("path"); os = require("os"); cp = require("child_process"); } catch (e) { /* prévia no navegador */ }

  function get(url, { timeout = 15000, redirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
      const lib = require(url.startsWith("https:") ? "https" : "http");
      const req = lib.get(url, { headers: { "User-Agent": "Rhythm-Premiere", Accept: "application/vnd.github+json" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(get(new URL(res.headers.location, url).toString(), { timeout, redirects: redirects - 1 }));
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        resolve(res);
      });
      req.setTimeout(timeout, () => req.destroy(new Error("tempo esgotado")));
      req.on("error", reject);
    });
  }

  async function fetchJson(url) {
    const res = await get(url);
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    return JSON.parse(body);
  }

  function currentVersion() {
    const cs = new CSInterface();
    const xml = fs.readFileSync(path.join(cs.getSystemPath(SystemPath.EXTENSION), "CSXS", "manifest.xml"), "utf8");
    const m = /ExtensionBundleVersion="([^"]+)"/.exec(xml);
    return m ? m[1] : null;
  }

  function checkUrl() {
    try { return localStorage.getItem("rhythm.updateUrl") || LATEST_URL; } catch (e) { return LATEST_URL; }
  }

  async function check(current) {
    return pickUpdate(await fetchJson(checkUrl()), current);
  }

  /** Baixa o instalador para %TEMP%\Rhythm-atualizacao (reaproveita se já estiver completo). */
  async function download(upd, onProgress) {
    const dir = path.join(os.tmpdir(), "Rhythm-atualizacao");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, upd.name);
    try { if (upd.size && fs.statSync(dest).size === upd.size) return dest; } catch (e) { /* não baixado */ }
    const part = dest + ".part";
    const res = await get(upd.url, { timeout: 30000 });
    const total = Number(res.headers["content-length"]) || upd.size || 0;
    let got = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      res.on("data", (c) => { got += c.length; if (total) onProgress(got / total); });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      res.pipe(out);
    });
    if (upd.size && got !== upd.size) throw new Error("download incompleto");
    try { fs.unlinkSync(dest); } catch (e) { /* não havia */ }
    fs.renameSync(part, dest);
    return dest;
  }

  /**
   * Dispara o instalador em /aguardar FORA da árvore de processos do Premiere
   * (via WMI), para ele sobreviver ao Premiere fechar.
   */
  function launchInstaller(exe) {
    const cmd = `"${exe}" /aguardar`.replace(/'/g, "''");
    return new Promise((resolve, reject) => {
      cp.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$r = ([wmiclass]'Win32_Process').Create('${cmd}'); exit $r.ReturnValue`],
      { windowsHide: true }, (err) => {
        if (!err) { resolve(); return; }
        try {
          cp.spawn(exe, ["/aguardar"], { detached: true, stdio: "ignore" }).unref();
          resolve();
        } catch (e) { reject(e); }
      });
    });
  }

  // ---------------------------------------------------------------- botão
  function mount(btn, note) {
    if (!btn || !fs) return;
    let current;
    try { current = currentVersion(); } catch (e) { return; }
    if (!current) return;
    const label = btn.querySelector(".update-btn-label");
    let upd = null;
    let state = "idle";

    const set = (text, title, cls) => {
      label.textContent = text;
      btn.title = title || "";
      btn.classList.toggle("update-btn--busy", cls === "busy");
      btn.classList.toggle("update-btn--error", cls === "error");
    };

    btn.addEventListener("click", async () => {
      if (state === "error") { try { new CSInterface().openURLInDefaultBrowser(upd.page); } catch (e) { /* ignora */ } return; }
      if (state !== "idle") return;
      state = "busy";
      try {
        set("Baixando… 0%", "", "busy");
        const exe = await download(upd, (f) => set(`Baixando… ${Math.floor(f * 100)}%`, "", "busy"));
        await launchInstaller(exe);
        state = "waiting";
        set("Feche o Premiere", "Salve seu projeto e feche o Premiere: a instalação termina sozinha.", "busy");
        if (note) {
          note.textContent = `Atualização ${shortVersion(upd.version)} pronta. Salve seu projeto e feche o Premiere: a instalação termina sozinha.`;
          note.hidden = false;
        }
      } catch (e) {
        state = "error";
        set("Não deu para atualizar", `${e.message}. Clique para baixar o instalador na página do GitHub.`, "error");
      }
    });

    check(current).then((u) => {
      if (!u) return;
      upd = u;
      set(`Atualizar para ${shortVersion(u.version)}`, u.notes ? `Novidades da ${shortVersion(u.version)}:\n\n${u.notes}` : "");
      btn.hidden = false;
    }).catch(() => { /* sem internet ou GitHub fora: nada a mostrar */ });
  }

  const api = { parseVersion, compareVersions, shortVersion, pickUpdate, check, download, launchInstaller, mount, LATEST_URL, RELEASES_PAGE };
  root.AEUpdate = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
