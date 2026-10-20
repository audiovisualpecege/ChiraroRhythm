/**
 * store.js — persistência.
 *  - prefs: parâmetros de cada aba (localStorage, por conveniência)
 *  - arquivo JSON na pasta do usuário: registros de Desfazer, que precisam
 *    sobreviver a fechar o painel ou o Premiere.
 */
(function (root) {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");

  function dataDir() {
    const base = process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), "Library", "Application Support");
    const dir = path.join(base, "AutomacaoEdicao");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* já existe */ }
    return dir;
  }

  function readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir(), name), "utf8"));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(name, value) {
    const file = path.join(dataDir(), name);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  }

  function loadPrefs(key, defaults) {
    try {
      const v = JSON.parse(localStorage.getItem(`ae.${key}`) || "null");
      return Object.assign({}, defaults, v || {});
    } catch (e) {
      return Object.assign({}, defaults);
    }
  }

  function savePrefs(key, value) {
    try { localStorage.setItem(`ae.${key}`, JSON.stringify(value)); } catch (e) { /* sem storage */ }
  }

  root.AEStore = { dataDir, readJson, writeJson, loadPrefs, savePrefs };
})(window);
