/**
 * levels.js
 *
 * Transforma o áudio de um trecho de mídia num "envelope" de energia: um
 * valor por milissegundo com a média dos quadrados das amostras (do canal
 * mais alto). É pequeno (1 hora = 3,6 milhões de floats) e é tudo o que a
 * detecção de silêncio e a forma de onda precisam — então, depois de
 * analisar uma vez, mudar sensibilidade/janela/margens é instantâneo.
 */
(function (root, factory) {
  const api = factory(root.AEContainers || (typeof require === "function" ? require("./containers.js") : null));
  root.AELevels = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function (Containers) {
  const BLOCK_MS = 1;
  const READ_BYTES = 4 * 1024 * 1024;

  // Pausa curta para a interface. setTimeout(0) custa ~15 ms no CEP 12 (68/s, medido
  // 07/10) e o Chromium pode frear timers de painel em segundo plano; MessageChannel
  // não sofre nenhum dos dois (~90 mil/s). Em Node (testes, workers): setImmediate.
  const yieldToUi = (() => {
    if (typeof window !== "undefined" && typeof MessageChannel === "function") {
      const ch = new MessageChannel();
      const waiting = [];
      ch.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
      return () => new Promise((r) => { waiting.push(r); ch.port2.postMessage(0); });
    }
    if (typeof setImmediate === "function") return () => new Promise((r) => setImmediate(r));
    return () => new Promise((r) => setTimeout(r, 0));
  })();
  /** Acumulador de blocos de 1 ms, com fronteiras exatas mesmo em 44,1 kHz. */
  class BlockAccumulator {
    constructor(sampleRate, channels, totalFrames) {
      this.sr = sampleRate;
      this.ch = channels;
      this.blocks = new Float32Array(Math.max(1, Math.ceil((totalFrames * 1000) / sampleRate / BLOCK_MS)));
      this.sums = new Float64Array(channels);
      this.count = 0;
      this.block = 0;
      this.frame = 0;
      this.nextBoundary = this.boundaryOf(1);
    }
    boundaryOf(b) {
      return Math.round((b * BLOCK_MS * this.sr) / 1000);
    }
    /** Fecha o bloco atual. */
    flush() {
      if (this.count > 0 && this.block < this.blocks.length) {
        let max = 0;
        for (let c = 0; c < this.ch; c++) if (this.sums[c] > max) max = this.sums[c];
        this.blocks[this.block] = max / this.count;
      }
      this.sums.fill(0);
      this.count = 0;
      this.block++;
      this.nextBoundary = this.boundaryOf(this.block + 1);
    }
    /** Chamado uma vez por quadro, depois de somar os canais com add(). */
    endFrame() {
      this.count++;
      this.frame++;
      if (this.frame >= this.nextBoundary) this.flush();
    }
    finish() {
      if (this.count > 0) this.flush();
      return this.blocks;
    }
  }

  /** Envelope de um trecho de PCM (WAV ou MP4/MOV com PCM). */
  async function pcmEnvelope(src, info, fromSec, toSec, onProgress) {
    const sr = info.sampleRate;
    const ch = info.channels;
    const fb = info.frameBytes;
    const bps = info.bytesPerSample;
    const read = info.read;

    const startFrame = Math.max(0, Math.floor(fromSec * sr));
    const lastChunk = info.chunks[info.chunks.length - 1];
    const fileFrames = lastChunk ? lastChunk.firstFrame + lastChunk.frames : 0;
    const endFrame = Math.min(fileFrames, Math.ceil(toSec * sr));
    const total = Math.max(0, endFrame - startFrame);
    const acc = new BlockAccumulator(sr, ch, total);
    if (!total) return { startSec: startFrame / sr, blockMs: BLOCK_MS, ms: acc.finish() };

    // Caminho rápido para 16 bits (o caso das câmeras e da maioria dos WAV)
    const fast16 = bps === 2 && !info.isFloat;
    const bigEndian = fast16 && read(Buffer.from([0x01, 0x00]), 0) > 0.0078; // 0x0100 BE = 256 -> 0.0078

    let done = 0;
    let lastYield = Date.now();
    for (const chunk of info.chunks) {
      const cStart = chunk.firstFrame;
      const cEnd = chunk.firstFrame + chunk.frames;
      if (cEnd <= startFrame) continue;
      if (cStart >= endFrame) break;

      let f = Math.max(cStart, startFrame);
      const fEnd = Math.min(cEnd, endFrame);
      while (f < fEnd) {
        const framesNow = Math.min(fEnd - f, Math.floor(READ_BYTES / fb));
        const buf = src.read(chunk.offset + (f - cStart) * fb, framesNow * fb);
        const n = Math.floor(buf.length / fb);
        const sums = acc.sums;
        for (let i = 0; i < n; i++) {
          const base = i * fb;
          for (let c = 0; c < ch; c++) {
            let s;
            if (fast16) {
              const o = base + c * 2;
              let v = bigEndian ? (buf[o] << 8) | buf[o + 1] : (buf[o + 1] << 8) | buf[o];
              if (v & 0x8000) v -= 0x10000;
              s = v / 32768;
            } else {
              s = read(buf, base + c * bps);
            }
            sums[c] += s * s;
          }
          acc.endFrame();
        }
        f += framesNow;
        done += framesNow;
        if (Date.now() - lastYield > 40) {
          if (onProgress) onProgress(done / total);
          await yieldToUi();
          lastYield = Date.now();
        }
        if (n < framesNow) break; // arquivo truncado
      }
    }
    if (onProgress) onProgress(1);
    return { startSec: startFrame / sr, blockMs: BLOCK_MS, ms: acc.finish() };
  }

  /** Envelope a partir de canais já decodificados (Float32Array por canal). */
  function channelsEnvelope(channelData, sampleRate, startSec, fromFrame, toFrame) {
    const ch = channelData.length;
    fromFrame = Math.max(0, fromFrame || 0);
    toFrame = Math.min(channelData[0] ? channelData[0].length : 0, toFrame == null ? Infinity : toFrame);
    const total = Math.max(0, toFrame - fromFrame);
    const acc = new BlockAccumulator(sampleRate, ch, total);
    for (let i = fromFrame; i < toFrame; i++) {
      for (let c = 0; c < ch; c++) {
        const s = channelData[c][i];
        acc.sums[c] += s * s;
      }
      acc.endFrame();
    }
    return { startSec: startSec + fromFrame / sampleRate, blockMs: BLOCK_MS, ms: acc.finish() };
  }

  /** Junta envelopes consecutivos (pedaços decodificados em sequência). */
  function concatEnvelopes(parts, startSec) {
    const total = parts.reduce((n, p) => n + p.ms.length, 0);
    const ms = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      ms.set(p.ms, o);
      o += p.ms.length;
    }
    return { startSec, blockMs: BLOCK_MS, ms };
  }

  /**
   * Envelope de um trecho de áudio comprimido (AAC/MP3 dentro de MP4/MOV),
   * decodificado em pedaços de ~60 s para não estourar memória.
   * @param decode fn(bytes: Buffer, sampleRate) -> Promise<{ sampleRate, channelData: Float32Array[] }>
   */
  async function compressedEnvelope(src, info, fromSec, toSec, decode, onProgress) {
    const PIECE = 60;
    const parts = [];
    for (let t = fromSec; t < toSec; t += PIECE) {
      const pieceEnd = Math.min(toSec, t + PIECE);
      const slice = Containers.buildCompressedSlice(src, info, t, pieceEnd, 2);
      if (!slice) break;
      const decoded = await decode(slice.bytes, info.sampleRate);
      const sr = decoded.sampleRate;
      const from = Math.max(0, Math.round((t - slice.startSec) * sr));
      const to = Math.round((pieceEnd - slice.startSec) * sr);
      parts.push(channelsEnvelope(decoded.channelData, sr, slice.startSec, from, to));
      if (onProgress) onProgress((pieceEnd - fromSec) / Math.max(0.001, toSec - fromSec));
      await yieldToUi();
    }
    return concatEnvelopes(parts, fromSec);
  }

  /**
   * Envelope do trecho [fromSec, toSec) (tempo de apresentação da mídia,
   * o mesmo do inPoint/outPoint do Premiere) de um arquivo aberto.
   */
  async function mediaEnvelope(media, fromSec, toSec, decode, onProgress) {
    const { src, info } = media;
    const off = info.timeOffsetSec || 0;
    if (info.kind === "pcm") {
      const env = await pcmEnvelope(src, info, fromSec + off, toSec + off, onProgress);
      env.startSec -= off;
      return env;
    }
    if (!decode) throw new Error("Este formato precisa do decodificador do Premiere/Chromium (só funciona dentro do painel).");
    if (info.kind === "compressed") {
      const env = await compressedEnvelope(src, info, fromSec + off, toSec + off, decode, onProgress);
      env.startSec -= off;
      return env;
    }
    // Arquivo inteiro (MP3, M4A pequeno, etc.): decodifica uma vez e guarda
    if (!info._decoded) {
      info._decoded = await decode(src.read(0, src.size), null);
    }
    const d = info._decoded;
    const sr = d.sampleRate;
    return channelsEnvelope(d.channelData, sr, 0, Math.floor(fromSec * sr), Math.ceil(toSec * sr));
  }

  // -------------------------------------------------------------------------
  // Utilidades sobre envelopes
  // -------------------------------------------------------------------------
  function toDb(meanSquare) {
    return meanSquare > 1e-12 ? 10 * Math.log10(meanSquare) : -120;
  }

  return { BLOCK_MS, mediaEnvelope, pcmEnvelope, channelsEnvelope, concatEnvelopes, toDb };
});
