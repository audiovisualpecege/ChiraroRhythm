/**
 * syncCache.js — guarda no disco o que a leitura de áudio produziu (impressões,
 * envelope, forma de onda compacta e hora de gravação), para analisar de novo
 * sem reler os arquivos. Chave: caminho + tamanho + data de modificação; se o
 * arquivo mudar, a chave muda e ele é lido de novo.
 *
 * Limite de tamanho: ao gravar, apaga os mais antigos (por último uso) até
 * caber no limite.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncCache = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const fs = require("fs");
  const pathMod = require("path");
  const crypto = require("crypto");

  const MAGIC = 0x52485931; // "RHY1"
  const VERSION = 1;

  function keyOf(mediaPath) {
    let st;
    try { st = fs.statSync(mediaPath); } catch (e) { return null; }
    const h = crypto.createHash("sha1").update(`${pathMod.normalize(mediaPath).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}|v${VERSION}`).digest("hex");
    return h + ".rfeat";
  }

  /** Serializa um feat (saída de syncAudio.analyzeFile + clock). */
  function encode(f) {
    const head = Buffer.alloc(48);
    head.writeUInt32LE(MAGIC, 0);
    head.writeUInt32LE(VERSION, 4);
    head.writeUInt32LE(f.env.length, 8);
    head.writeUInt32LE(f.lm.hash.length, 12);
    head.writeUInt32LE(f.wave.length, 16);
    head.writeDoubleLE(f.durationSec, 20);
    head.writeDoubleLE(f.clock == null ? NaN : f.clock, 28);
    head.writeUInt32LE(f.envMs, 36);
    head.writeUInt32LE(f.waveSr, 40);
    head.writeFloatLE(f.hopSec, 44);
    const pad = Buffer.alloc((4 - (f.wave.length % 4)) % 4);
    return Buffer.concat([
      head,
      Buffer.from(f.env.buffer, f.env.byteOffset, f.env.byteLength),
      Buffer.from(f.lm.hash.buffer, f.lm.hash.byteOffset, f.lm.hash.byteLength),
      Buffer.from(f.lm.t.buffer, f.lm.t.byteOffset, f.lm.t.byteLength),
      Buffer.from(f.wave.buffer, f.wave.byteOffset, f.wave.byteLength),
      pad,
    ]);
  }

  function decode(b) {
    if (b.length < 48 || b.readUInt32LE(0) !== MAGIC || b.readUInt32LE(4) !== VERSION) return null;
    const ne = b.readUInt32LE(8), nl = b.readUInt32LE(12), nw = b.readUInt32LE(16);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    let o = 48;
    const env = new Float32Array(ab, o, ne); o += ne * 4;
    const hash = new Uint32Array(ab, o, nl); o += nl * 4;
    const t = new Uint32Array(ab, o, nl); o += nl * 4;
    const wave = new Int8Array(ab, o, nw);
    const clock = b.readDoubleLE(28);
    return {
      env, wave, lm: { hash, t },
      durationSec: b.readDoubleLE(20),
      clock: Number.isNaN(clock) ? null : clock,
      envMs: b.readUInt32LE(36),
      waveSr: b.readUInt32LE(40),
      hopSec: b.readFloatLE(44),
    };
  }

  function load(dir, mediaPath) {
    const k = keyOf(mediaPath);
    if (!k) return null;
    const file = pathMod.join(dir, k);
    try {
      const f = decode(fs.readFileSync(file));
      if (f) { const now = new Date(); try { fs.utimesSync(file, now, now); } catch (e) {} }
      return f;
    } catch (e) {
      return null;
    }
  }

  function save(dir, mediaPath, feat) {
    const k = keyOf(mediaPath);
    if (!k) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = pathMod.join(dir, k);
      fs.writeFileSync(file + ".tmp", encode(feat));
      fs.renameSync(file + ".tmp", file);
    } catch (e) { /* cache é só conveniência */ }
  }

  function list(dir) {
    try {
      return fs.readdirSync(dir).filter((n) => n.endsWith(".rfeat")).map((n) => {
        const p = pathMod.join(dir, n);
        const st = fs.statSync(p);
        return { p, size: st.size, used: st.mtimeMs };
      });
    } catch (e) {
      return [];
    }
  }

  /** Apaga os menos usados até o total caber em maxBytes. */
  function prune(dir, maxBytes) {
    const items = list(dir).sort((a, b) => a.used - b.used);
    let total = items.reduce((s, x) => s + x.size, 0);
    for (const x of items) {
      if (total <= maxBytes) break;
      try { fs.unlinkSync(x.p); total -= x.size; } catch (e) {}
    }
    return total;
  }

  function sizeOf(dir) {
    return list(dir).reduce((s, x) => s + x.size, 0);
  }

  function clear(dir) {
    let n = 0;
    for (const x of list(dir)) { try { fs.unlinkSync(x.p); n++; } catch (e) {} }
    return n;
  }

  return { keyOf, encode, decode, load, save, prune, sizeOf, clear };
});
