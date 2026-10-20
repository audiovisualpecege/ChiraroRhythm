/**
 * CSInterface.js — subconjunto do CSInterface oficial da Adobe
 * (https://github.com/Adobe-CEP/CEP-Resources), só com o que o painel usa.
 * A API é a mesma do oficial; dá para trocar pelo arquivo completo sem
 * mudar o resto do código.
 */
function CSInterface() {}

CSInterface.SystemPath = {
  USER_DATA: "userData",
  COMMON_FILES: "commonFiles",
  MY_DOCUMENTS: "myDocuments",
  APPLICATION: "application",
  EXTENSION: "extension",
  HOST_APPLICATION: "hostApplication",
};

CSInterface.prototype.isInHost = function () {
  return typeof window !== "undefined" && !!window.__adobe_cep__;
};

CSInterface.prototype.evalScript = function (script, callback) {
  callback = callback || function () {};
  if (!this.isInHost()) {
    callback("EvalScript error.");
    return;
  }
  window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getHostEnvironment = function () {
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return null;
  }
};

CSInterface.prototype.getSystemPath = function (pathType) {
  var p = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
  if (/^file:\/\/\/[A-Za-z]:/.test(p)) p = p.replace("file:///", "");
  else p = p.replace("file://", "");
  return p;
};

CSInterface.prototype.addEventListener = function (type, listener) {
  if (this.isInHost()) window.__adobe_cep__.addEventListener(type, listener);
};
