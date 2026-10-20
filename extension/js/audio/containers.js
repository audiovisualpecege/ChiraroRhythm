/**
 * containers.js
 *
 * Lê o áudio direto dos arquivos de mídia usados na timeline, sem ffmpeg e
 * sem Media Encoder. Só lê do disco os trechos de áudio que a timeline usa
 * (um arquivo 4K de 20 GB rende só alguns MB de leitura).
 *
 *  - WAV / BWF / RF64 ............ PCM lido direto
 *  - MP4 / MOV / M4A (ISO BMFF) .. PCM (lpcm, sowt, twos, in24, in32, fl32,
 *                                  fl64, ipcm) lido direto; AAC extraído
 *                                  quadro a quadro e decodificado pelo
 *                                  decodificador nativo do Chromium
 *  - MP3, M4A, AAC, OGG, FLAC .... arquivo inteiro pelo decodificador nativo
 *
 * Funciona no painel CEP (Node + Chromium) e no Node puro (testes), exceto
 * a decodificação de AAC/MP3, que precisa do Web Audio do Chromium.
 */
(function (root, factory) {
  const api = factory();
  root.AEContainers = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const fs = require("fs");
  const path = require("path");

  // -------------------------------------------------------------------------
  // Arquivo com leitura posicional
  // -------------------------------------------------------------------------
  class FileSource {
    constructor(filePath) {
      this.path = filePath;
      this.fd = fs.openSync(filePath, "r");
      this.size = fs.fstatSync(this.fd).size;
    }
    read(offset, length) {
      length = Math.max(0, Math.min(length, this.size - offset));
      const buf = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const n = fs.readSync(this.fd, buf, done, length - done, offset + done);
        if (n <= 0) break;
        done += n;
      }
      return done === length ? buf : buf.subarray(0, done);
    }
    close() {
      try { fs.closeSync(this.fd); } catch (e) { /* já fechado */ }
    }
  }

  // -------------------------------------------------------------------------
  // Leitores de amostra PCM
  // -------------------------------------------------------------------------
  /** Devolve fn(buf, byteOffset) -> amostra em [-1, 1]. */
  function pcmReader(bits, isFloat, bigEndian, unsigned8) {
    if (isFloat && bits === 32) return bigEndian ? (b, o) => b.readFloatBE(o) : (b, o) => b.readFloatLE(o);
    if (isFloat && bits === 64) return bigEndian ? (b, o) => b.readDoubleBE(o) : (b, o) => b.readDoubleLE(o);
    if (bits === 8) return unsigned8 ? (b, o) => (b[o] - 128) / 128 : (b, o) => b.readInt8(o) / 128;
    if (bits === 16) return bigEndian ? (b, o) => b.readInt16BE(o) / 32768 : (b, o) => b.readInt16LE(o) / 32768;
    if (bits === 24) return bigEndian ? (b, o) => b.readIntBE(o, 3) / 8388608 : (b, o) => b.readIntLE(o, 3) / 8388608;
    if (bits === 32) return bigEndian ? (b, o) => b.readInt32BE(o) / 2147483648 : (b, o) => b.readInt32LE(o) / 2147483648;
    throw new Error(`Formato PCM não suportado (${bits} bits${isFloat ? " float" : ""}).`);
  }

  // -------------------------------------------------------------------------
  // WAV / BWF / RF64
  // -------------------------------------------------------------------------
  function probeWav(src) {
    const head = src.read(0, 12);
    const riff = head.toString("ascii", 0, 4);
    if ((riff !== "RIFF" && riff !== "RF64" && riff !== "BW64") || head.toString("ascii", 8, 12) !== "WAVE") return null;

    let offset = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataSize = 0;
    let ds64DataSize = null;

    while (offset + 8 <= src.size) {
      const h = src.read(offset, 8);
      const id = h.toString("ascii", 0, 4);
      let size = h.readUInt32LE(4);
      const body = offset + 8;

      if (id === "ds64") {
        const d = src.read(body, 28);
        ds64DataSize = Number(d.readBigUInt64LE(8));
      } else if (id === "fmt ") {
        const f = src.read(body, Math.min(size, 40));
        let formatTag = f.readUInt16LE(0);
        const channels = f.readUInt16LE(2);
        const sampleRate = f.readUInt32LE(4);
        const blockAlign = f.readUInt16LE(12);
        const bits = f.readUInt16LE(14);
        if (formatTag === 0xfffe && size >= 26) formatTag = f.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE
        fmt = { formatTag, channels, sampleRate, blockAlign, bits };
      } else if (id === "data") {
        dataOffset = body;
        if (size === 0xffffffff && ds64DataSize != null) size = ds64DataSize;
        dataSize = Math.min(size, src.size - body);
        if (fmt) break; // não precisa varrer o resto
      }
      if (size === 0xffffffff) break;
      offset = body + size + (size % 2);
    }

    if (!fmt || dataOffset < 0) throw new Error("WAV sem os blocos 'fmt ' ou 'data'.");
    if (fmt.formatTag !== 1 && fmt.formatTag !== 3) {
      throw new Error(`WAV com codificação ${fmt.formatTag} (não é PCM) não é suportado.`);
    }
    const bytesPerSample = fmt.bits / 8;
    const frameBytes = fmt.blockAlign || bytesPerSample * fmt.channels;
    return {
      kind: "pcm",
      container: "wav",
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      durationSec: Math.floor(dataSize / frameBytes) / fmt.sampleRate,
      read: pcmReader(fmt.bits, fmt.formatTag === 3, false, fmt.bits === 8),
      bytesPerSample,
      frameBytes,
      // Um único "chunk" contínuo
      chunks: [{ offset: dataOffset, firstFrame: 0, frames: Math.floor(dataSize / frameBytes) }],
      timeOffsetSec: 0,
    };
  }

  // -------------------------------------------------------------------------
  // ISO BMFF (MP4 / MOV / M4A)
  // -------------------------------------------------------------------------
  function readBoxHeader(buf, pos, end) {
    if (pos + 8 > end) return null;
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return null;
    return { type, start: pos, size, body: pos + header, end: Math.min(pos + size, end) };
  }

  function children(buf, start, end) {
    const out = [];
    let pos = start;
    while (pos < end) {
      const b = readBoxHeader(buf, pos, end);
      if (!b) break;
      out.push(b);
      pos = b.start + b.size;
    }
    return out;
  }

  function child(buf, box, type) {
    return children(buf, box.body, box.end).find((b) => b.type === type) || null;
  }

  /** Acha o 'moov' varrendo só os cabeçalhos do topo (o mdat pode ter GBs). */
  function findMoov(src) {
    let pos = 0;
    while (pos + 8 <= src.size) {
      const h = src.read(pos, 16);
      let size = h.readUInt32BE(0);
      const type = h.toString("latin1", 4, 8);
      if (size === 1) size = Number(h.readBigUInt64BE(8));
      else if (size === 0) size = src.size - pos;
      if (size < 8) return null;
      if (type === "moov") return src.read(pos, size);
      pos += size;
    }
    return null;
  }

  function looksLikeIsoBmff(src) {
    if (src.size < 12) return false;
    const type = src.read(4, 4).toString("latin1");
    return ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].includes(type);
  }

  function parseFullBoxVersion(buf, box) {
    return buf[box.body];
  }

  function readDescriptorLength(buf, pos) {
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = buf[pos++];
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { len, pos };
  }

  /** esds -> { objectType, asc } */
  function parseEsds(buf, box) {
    let pos = box.body + 4;
    const end = box.end;
    let objectType = null;
    let asc = null;
    while (pos < end) {
      const tag = buf[pos++];
      const l = readDescriptorLength(buf, pos);
      pos = l.pos;
      if (tag === 0x03) {
        pos += 2; // ES_ID
        const flags = buf[pos++];
        if (flags & 0x80) pos += 2;
        if (flags & 0x40) pos += 1 + buf[pos];
        if (flags & 0x20) pos += 2;
        continue; // desce para os descritores internos
      }
      if (tag === 0x04) {
        objectType = buf[pos];
        pos += 13;
        continue;
      }
      if (tag === 0x05) {
        asc = buf.subarray(pos, pos + l.len);
        break;
      }
      pos += l.len;
    }
    return { objectType, asc };
  }

  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function parseAsc(asc) {
    if (!asc || asc.length < 2) return null;
    let aot = asc[0] >> 3;
    let rateIndex = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
    let channelConfig = (asc[1] >> 3) & 0x0f;
    if (aot === 31 || rateIndex === 15) return { aot, rateIndex, channelConfig, unsupported: true };
    return { aot, rateIndex, channelConfig, sampleRate: AAC_RATES[rateIndex] };
  }

  function parseSoundEntry(buf, entry) {
    const format = entry.type;
    const p = entry.body; // após size+type
    const version = buf.readUInt16BE(p + 8);
    let channels = buf.readUInt16BE(p + 16);
    let bits = buf.readUInt16BE(p + 18);
    let sampleRate = buf.readUInt32BE(p + 24) / 65536;
    let childStart = p + 28;
    let bytesPerFrame = null;
    let lpcmFlags = null;

    if (version === 1) {
      const bytesPerFrameV1 = buf.readUInt32BE(p + 28 + 8);
      if (bytesPerFrameV1) bytesPerFrame = bytesPerFrameV1;
      childStart = p + 44;
    } else if (version === 2) {
      sampleRate = buf.readDoubleBE(p + 32);
      channels = buf.readUInt32BE(p + 40);
      bits = buf.readUInt32BE(p + 48);
      lpcmFlags = buf.readUInt32BE(p + 52);
      const constBytesPerPacket = buf.readUInt32BE(p + 56);
      const framesPerPacket = buf.readUInt32BE(p + 60);
      if (constBytesPerPacket && framesPerPacket === 1) bytesPerFrame = constBytesPerPacket;
      childStart = p + 64;
    }
    const kids = childStart < entry.end ? children(buf, childStart, entry.end) : [];
    return { format, version, channels, bits, sampleRate, bytesPerFrame, lpcmFlags, kids };
  }

  /** Descobre o formato de PCM a partir do tipo de entrada do stsd. */
  function pcmFormatFor(se, buf) {
    const f = se.format;
    let bits = se.bits;
    let isFloat = false;
    let bigEndian = true;
    let unsigned8 = false;
    const enda = se.kids.find((k) => k.type === "enda");
    const endaLittle = enda ? buf.readUInt16BE(enda.body) === 1 : false;

    switch (f) {
      case "sowt": bigEndian = false; break;
      case "twos": bigEndian = true; break;
      case "raw ": bits = 8; unsigned8 = true; break;
      case "in24": bits = 24; bigEndian = !endaLittle; break;
      case "in32": bits = 32; bigEndian = !endaLittle; break;
      case "fl32": bits = 32; isFloat = true; bigEndian = !endaLittle; break;
      case "fl64": bits = 64; isFloat = true; bigEndian = !endaLittle; break;
      case "lpcm": {
        const fl = se.lpcmFlags || 0;
        isFloat = !!(fl & 1);
        bigEndian = !!(fl & 2);
        if (fl & 32) throw new Error("PCM não intercalado em MOV não é suportado.");
        break;
      }
      case "ipcm":
      case "fpcm": {
        const pcmC = se.kids.find((k) => k.type === "pcmC");
        if (pcmC) {
          const flags = buf[pcmC.body + 4];
          bigEndian = !(flags & 1);
          bits = buf[pcmC.body + 5];
        }
        isFloat = f === "fpcm";
        break;
      }
      default:
        return null;
    }
    return { bits, isFloat, bigEndian, unsigned8 };
  }

  function parseSampleTables(buf, stbl) {
    const box = (t) => child(buf, stbl, t);
    const stsz = box("stsz");
    const stz2 = box("stz2");
    const stsc = box("stsc");
    const stco = box("stco");
    const co64 = box("co64");
    const stts = box("stts");
    if ((!stsz && !stz2) || !stsc || (!stco && !co64)) throw new Error("Tabelas de amostra incompletas no MP4/MOV.");

    // Tamanhos das amostras
    let sampleSize = 0;
    let sizes = null;
    let sampleCount = 0;
    if (stsz) {
      sampleSize = buf.readUInt32BE(stsz.body + 4);
      sampleCount = buf.readUInt32BE(stsz.body + 8);
      if (sampleSize === 0) {
        sizes = new Uint32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) sizes[i] = buf.readUInt32BE(stsz.body + 12 + i * 4);
      }
    } else {
      const fieldSize = buf[stz2.body + 7];
      sampleCount = buf.readUInt32BE(stz2.body + 8);
      sizes = new Uint32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        if (fieldSize === 16) sizes[i] = buf.readUInt16BE(stz2.body + 12 + i * 2);
        else if (fieldSize === 8) sizes[i] = buf[stz2.body + 12 + i];
        else {
          const b = buf[stz2.body + 12 + (i >> 1)];
          sizes[i] = i & 1 ? b & 0x0f : b >> 4;
        }
      }
    }

    // Offsets dos chunks
    let chunkOffsets;
    if (stco) {
      const n = buf.readUInt32BE(stco.body + 4);
      chunkOffsets = new Float64Array(n);
      for (let i = 0; i < n; i++) chunkOffsets[i] = buf.readUInt32BE(stco.body + 8 + i * 4);
    } else {
      const n = buf.readUInt32BE(co64.body + 4);
      chunkOffsets = new Float64Array(n);
      for (let i = 0; i < n; i++) chunkOffsets[i] = Number(buf.readBigUInt64BE(co64.body + 8 + i * 8));
    }

    // Amostras por chunk
    const scEntries = buf.readUInt32BE(stsc.body + 4);
    const sc = [];
    for (let i = 0; i < scEntries; i++) {
      const o = stsc.body + 8 + i * 12;
      sc.push({ firstChunk: buf.readUInt32BE(o), perChunk: buf.readUInt32BE(o + 4) });
    }
    const samplesPerChunk = new Uint32Array(chunkOffsets.length);
    for (let i = 0; i < sc.length; i++) {
      const from = sc[i].firstChunk - 1;
      const to = i + 1 < sc.length ? sc[i + 1].firstChunk - 1 : chunkOffsets.length;
      for (let c = from; c < to && c < chunkOffsets.length; c++) samplesPerChunk[c] = sc[i].perChunk;
    }

    // Duração de cada amostra (só precisamos saber se é constante)
    const deltas = [];
    if (stts) {
      const n = buf.readUInt32BE(stts.body + 4);
      for (let i = 0; i < n; i++) {
        const o = stts.body + 8 + i * 8;
        deltas.push({ count: buf.readUInt32BE(o), delta: buf.readUInt32BE(o + 4) });
      }
    }
    return { sampleSize, sizes, sampleCount, chunkOffsets, samplesPerChunk, deltas };
  }

  function parseEditOffsetSec(buf, trak, mediaTimescale, movieTimescale) {
    const edts = child(buf, trak, "edts");
    const elst = edts ? child(buf, edts, "elst") : null;
    if (!elst) return 0;
    const v = parseFullBoxVersion(buf, elst);
    const n = buf.readUInt32BE(elst.body + 4);
    let pos = elst.body + 8;
    let delaySec = 0;
    for (let i = 0; i < n; i++) {
      let segDur, mediaTime;
      if (v === 1) {
        segDur = Number(buf.readBigUInt64BE(pos));
        mediaTime = Number(buf.readBigInt64BE(pos + 8));
        pos += 20;
      } else {
        segDur = buf.readUInt32BE(pos);
        mediaTime = buf.readInt32BE(pos + 4);
        pos += 12;
      }
      if (mediaTime === -1) {
        delaySec += segDur / movieTimescale;
        continue;
      }
      // tempo de apresentação p  ->  tempo de mídia  p - delay + mediaTime
      return mediaTime / mediaTimescale - delaySec;
    }
    return -delaySec;
  }

  function probeIsoBmff(src) {
    const moov = findMoov(src);
    if (!moov) throw new Error("Arquivo MP4/MOV sem 'moov' (arquivo incompleto ou ainda gravando?).");
    const root = { body: 0, end: moov.length, type: "root" };
    const moovBox = children(moov, 0, moov.length)[0];
    const mvhd = child(moov, moovBox, "mvhd");
    const mvhdV = mvhd ? parseFullBoxVersion(moov, mvhd) : 0;
    const movieTimescale = mvhd ? moov.readUInt32BE(mvhd.body + (mvhdV === 1 ? 20 : 12)) : 1000;
    void root;

    const traks = children(moov, moovBox.body, moovBox.end).filter((b) => b.type === "trak");
    for (const trak of traks) {
      const mdia = child(moov, trak, "mdia");
      if (!mdia) continue;
      const hdlr = child(moov, mdia, "hdlr");
      if (!hdlr || moov.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "soun") continue;

      const mdhd = child(moov, mdia, "mdhd");
      const mdV = parseFullBoxVersion(moov, mdhd);
      const timescale = moov.readUInt32BE(mdhd.body + (mdV === 1 ? 20 : 12));
      const minf = child(moov, mdia, "minf");
      const stbl = minf && child(moov, minf, "stbl");
      const stsd = stbl && child(moov, stbl, "stsd");
      if (!stsd) continue;
      const entry = children(moov, stsd.body + 8, stsd.end)[0];
      if (!entry) continue;

      const se = parseSoundEntry(moov, entry);
      const tables = parseSampleTables(moov, stbl);
      const timeOffsetSec = parseEditOffsetSec(moov, trak, timescale, movieTimescale);

      const pcm = pcmFormatFor(se, moov);
      if (pcm) {
        const bytesPerSample = pcm.bits / 8;
        const frameBytes = se.bytesPerFrame || bytesPerSample * se.channels;
        const sampleRate = se.version === 2 ? se.sampleRate : timescale || se.sampleRate;
        const chunks = [];
        let sampleIdx = 0;
        let frame = 0;
        for (let c = 0; c < tables.chunkOffsets.length; c++) {
          const n = tables.samplesPerChunk[c];
          let bytes;
          if (tables.sizes) {
            bytes = 0;
            for (let i = 0; i < n; i++) bytes += tables.sizes[sampleIdx + i];
          } else {
            // stsz com tamanho fixo: 1 = convenção antiga do QuickTime (1 amostra = 1 quadro PCM)
            bytes = tables.sampleSize <= 1 ? n * frameBytes : n * tables.sampleSize;
          }
          sampleIdx += n;
          const frames = Math.floor(bytes / frameBytes);
          chunks.push({ offset: tables.chunkOffsets[c], firstFrame: frame, frames });
          frame += frames;
        }
        return {
          kind: "pcm",
          container: "isobmff",
          codec: se.format,
          sampleRate,
          channels: se.channels,
          durationSec: frame / sampleRate,
          read: pcmReader(pcm.bits, pcm.isFloat, pcm.bigEndian, pcm.unsigned8),
          bytesPerSample,
          frameBytes,
          chunks,
          timeOffsetSec,
        };
      }

      if (se.format === "mp4a") {
        const esdsBox = se.kids.find((k) => k.type === "esds") ||
          (se.kids.find((k) => k.type === "wave") && children(moov, se.kids.find((k) => k.type === "wave").body, se.kids.find((k) => k.type === "wave").end).find((k) => k.type === "esds"));
        if (!esdsBox) throw new Error("Áudio AAC sem configuração (esds).");
        const esds = parseEsds(moov, esdsBox);
        const isMp3 = esds.objectType === 0x6b || esds.objectType === 0x69;
        const asc = isMp3 ? null : parseAsc(esds.asc);
        if (!isMp3 && (!asc || asc.unsupported || asc.channelConfig === 0)) {
          throw new Error("Configuração de AAC não suportada neste arquivo.");
        }

        // Tabela de amostras comprimidas: offset, tamanho e tempo (em unidades da timescale)
        const n = tables.sampleCount;
        const offsets = new Float64Array(n);
        const sizes = new Uint32Array(n);
        let s = 0;
        for (let c = 0; c < tables.chunkOffsets.length && s < n; c++) {
          let off = tables.chunkOffsets[c];
          for (let i = 0; i < tables.samplesPerChunk[c] && s < n; i++, s++) {
            const sz = tables.sizes ? tables.sizes[s] : tables.sampleSize;
            offsets[s] = off;
            sizes[s] = sz;
            off += sz;
          }
        }
        const times = new Float64Array(n + 1);
        let t = 0;
        let k = 0;
        for (const d of tables.deltas) {
          for (let i = 0; i < d.count && k < n; i++, k++) {
            times[k] = t;
            t += d.delta;
          }
        }
        for (; k <= n; k++) times[k] = t;

        return {
          kind: "compressed",
          container: "isobmff",
          codec: isMp3 ? "mp3" : "aac",
          sampleRate: asc ? asc.sampleRate : timescale,
          channels: asc ? asc.channelConfig : se.channels,
          durationSec: t / timescale,
          aac: asc,
          timescale,
          samples: { offsets, sizes, times, count: n },
          timeOffsetSec,
        };
      }

      throw new Error(`Codec de áudio "${se.format}" não suportado.`);
    }
    throw new Error("O arquivo não tem faixa de áudio.");
  }

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------
  const WHOLE_FILE_EXTS = new Set([".mp3", ".aac", ".ogg", ".oga", ".opus", ".flac", ".webm"]);
  const MAX_WHOLE_FILE_BYTES = 400 * 1024 * 1024;

  /**
   * Abre um arquivo de mídia e descreve o áudio dele.
   * @returns {{ src: FileSource, info: object }}
   */
  function openMedia(filePath) {
    const src = new FileSource(filePath);
    try {
      const ext = path.extname(filePath).toLowerCase();
      let info = probeWav(src);
      if (!info && looksLikeIsoBmff(src)) {
        info = probeIsoBmff(src);
        // MP4 fragmentado (ex.: gravação do OBS) não tem tabela de amostras no moov:
        // decodifica o arquivo inteiro pelo decodificador nativo.
        const empty = (info.kind === "compressed" && !info.samples.count) || (info.kind === "pcm" && !info.durationSec);
        if (empty) {
          if (src.size > MAX_WHOLE_FILE_BYTES) throw new Error("MP4 fragmentado grande demais para decodificar inteiro.");
          info = { kind: "whole", container: "fmp4", timeOffsetSec: 0 };
        }
      }
      if (!info) {
        if (!WHOLE_FILE_EXTS.has(ext) && ext !== ".m4a") {
          throw new Error(`Formato "${ext || "sem extensão"}" não suportado para leitura de áudio.`);
        }
        if (src.size > MAX_WHOLE_FILE_BYTES) throw new Error("Arquivo de áudio comprimido grande demais para decodificar inteiro.");
        info = { kind: "whole", container: ext.slice(1), timeOffsetSec: 0 };
      }
      info.path = filePath;
      return { src, info };
    } catch (err) {
      src.close();
      throw err;
    }
  }

  /** Cabeçalho ADTS de 7 bytes para um quadro AAC cru. */
  function adtsHeader(asc, frameLen) {
    const len = frameLen + 7;
    const profile = Math.max(0, Math.min(3, asc.aot - 1));
    const h = Buffer.alloc(7);
    h[0] = 0xff;
    h[1] = 0xf1; // MPEG-4, layer 0, sem CRC
    h[2] = (profile << 6) | (asc.rateIndex << 2) | ((asc.channelConfig >> 2) & 0x01);
    h[3] = ((asc.channelConfig & 0x03) << 6) | ((len >> 11) & 0x03);
    h[4] = (len >> 3) & 0xff;
    h[5] = ((len & 0x07) << 5) | 0x1f;
    h[6] = 0xfc;
    return h;
  }

  /**
   * Monta um trecho de stream decodificável (ADTS para AAC, quadros crus
   * para MP3) cobrindo [fromSec, toSec) em tempo de mídia.
   * @returns {{ bytes: Buffer, startSec: number }} startSec = tempo de mídia do 1º quadro
   */
  function buildCompressedSlice(src, info, fromSec, toSec, prerollFrames) {
    const { samples, timescale } = info;
    const fromT = Math.max(0, fromSec) * timescale;
    const toT = Math.max(0, toSec) * timescale;
    // busca binária do primeiro quadro que termina depois de fromT
    let lo = 0;
    let hi = samples.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples.times[mid + 1] <= fromT) lo = mid + 1;
      else hi = mid;
    }
    const first = Math.max(0, lo - (prerollFrames || 0));
    let last = lo;
    while (last < samples.count && samples.times[last] < toT) last++;
    if (last <= first) return null;

    // Lê quadros vizinhos em blocos contíguos (são intercalados com vídeo no arquivo)
    const parts = [];
    let i = first;
    while (i < last) {
      let j = i;
      let end = samples.offsets[i] + samples.sizes[i];
      while (j + 1 < last && samples.offsets[j + 1] === end && end - samples.offsets[i] < 8 * 1024 * 1024) {
        j++;
        end += samples.sizes[j];
      }
      const block = src.read(samples.offsets[i], end - samples.offsets[i]);
      let p = 0;
      for (let k = i; k <= j; k++) {
        const frame = block.subarray(p, p + samples.sizes[k]);
        p += samples.sizes[k];
        if (info.codec === "aac") parts.push(adtsHeader(info.aac, frame.length));
        parts.push(frame);
      }
      i = j + 1;
    }
    return { bytes: Buffer.concat(parts), startSec: samples.times[first] / timescale };
  }

  return {
    FileSource,
    openMedia,
    buildCompressedSlice,
    pcmReader,
    _internal: { probeWav, probeIsoBmff, parseAsc, adtsHeader },
  };
});
