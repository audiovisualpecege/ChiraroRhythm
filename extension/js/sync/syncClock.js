/**
 * syncClock.js — hora de gravação de cada arquivo, pelo relógio do aparelho.
 *
 * Os relógios costumam estar errados (dia trocado, ano de fábrica…), então o
 * valor aqui NUNCA é usado cru: o plano corrige cada aparelho pelo que o áudio
 * sincronizou (ver syncPlan, "relógios"). Só precisa ser consistente dentro do
 * mesmo aparelho.
 *
 * Fontes, na ordem:
 *  - Sony (XAVC S / XAVC HS): XML ao lado do vídeo (C0001M01.XML) → CreationDate
 *  - WAV / BWF: bloco bext → data + timeReference (amostras desde a meia-noite)
 *  - MP4 / MOV em geral: mvhd.creation_time
 *
 * Devolve segundos (época Unix, "hora local do aparelho" tratada como UTC) ou null.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncClock = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const fs = require("fs");
  const pathMod = require("path");

  /** "2026-08-28T11:51:27-03:00" -> segundos (ignora o fuso: relógio do aparelho). */
  function parseIsoLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(String(s).trim());
    if (!m) return null;
    const frac = m[7] ? Number("0." + m[7]) : 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 + frac;
  }

  function sonyXml(path) {
    const dir = pathMod.dirname(path);
    const base = pathMod.basename(path).replace(/\.[^.]+$/, "");
    for (const name of [base + "M01.XML", base + "M01.xml", base + ".XML", base + ".xml"]) {
      const p = pathMod.join(dir, name);
      let txt;
      try { txt = fs.readFileSync(p, "utf8"); } catch (e) { continue; }
      const m = /CreationDate\s+value="([^"]+)"/i.exec(txt);
      if (m) return parseIsoLocal(m[1]);
    }
    return null;
  }

  function readAt(fd, pos, len) {
    const b = Buffer.alloc(len);
    const n = fs.readSync(fd, b, 0, len, pos);
    return n === len ? b : b.subarray(0, n);
  }

  function bwf(fd, size) {
    const head = readAt(fd, 0, 12);
    const riff = head.toString("ascii", 0, 4);
    if ((riff !== "RIFF" && riff !== "RF64" && riff !== "BW64") || head.toString("ascii", 8, 12) !== "WAVE") return null;
    let pos = 12, sr = 0, bext = null;
    while (pos + 8 <= size) {
      const h = readAt(fd, pos, 8);
      const id = h.toString("ascii", 0, 4);
      const sz = h.readUInt32LE(4);
      if (id === "fmt ") sr = readAt(fd, pos + 8, 16).readUInt32LE(4);
      else if (id === "bext") bext = readAt(fd, pos + 8, Math.min(sz, 346));
      if (id === "data" || sz === 0xffffffff) break;
      pos += 8 + sz + (sz % 2);
    }
    if (!bext || bext.length < 346) return null;
    const date = bext.toString("ascii", 320, 330).replace(/[^0-9]/g, "");
    const time = bext.toString("ascii", 330, 338).replace(/[^0-9]/g, "");
    if (date.length !== 8) return null;
    const day = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) / 1000;
    const ref = bext.readUInt32LE(338) + bext.readUInt32LE(342) * 4294967296;
    if (ref > 0 && sr > 0) return day + ref / sr; // início exato da gravação
    if (time.length === 6) return day + +time.slice(0, 2) * 3600 + +time.slice(2, 4) * 60 + +time.slice(4, 6);
    return null;
  }

  function mvhd(fd, size) {
    // acha o moov pelos cabeçalhos do topo e lê o creation_time do mvhd
    let pos = 0;
    while (pos + 8 <= size) {
      const h = readAt(fd, pos, 16);
      let sz = h.readUInt32BE(0);
      const type = h.toString("latin1", 4, 8);
      if (sz === 1) sz = Number(h.readBigUInt64BE(8));
      else if (sz === 0) sz = size - pos;
      if (sz < 8) return null;
      if (type === "moov") {
        const b = readAt(fd, pos, Math.min(sz, 4096));
        const i = b.indexOf("mvhd");
        if (i < 0) return null;
        const v = b[i + 4];
        const secs1904 = v === 1 ? Number(b.readBigUInt64BE(i + 8)) : b.readUInt32BE(i + 8);
        if (!secs1904) return null;
        return secs1904 - 2082844800; // 1904 -> 1970
      }
      pos += sz;
    }
    return null;
  }

  /** Hora de início da gravação (segundos) ou null. */
  function recordedAt(path) {
    try {
      const x = sonyXml(path);
      if (x != null) return { t: x, source: "xml" };
    } catch (e) { /* segue */ }
    let fd = null;
    try {
      fd = fs.openSync(path, "r");
      const size = fs.fstatSync(fd).size;
      const w = bwf(fd, size);
      if (w != null) return { t: w, source: "bext" };
      const m = mvhd(fd, size);
      if (m != null) return { t: m, source: "mvhd" };
    } catch (e) {
      /* sem relógio */
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch (e) {}
    }
    return null;
  }

  return { recordedAt, parseIsoLocal };
});
