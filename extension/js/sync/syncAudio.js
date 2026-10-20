/**
 * syncAudio.js
 *
 * Lê o áudio de um arquivo de mídia inteiro e extrai o que a sincronização
 * precisa, sem guardar o PCM:
 *
 *  - env: envelope de energia em dB, 1 valor a cada ENV_MS (2 ms) — usado no
 *    ajuste fino do deslocamento (precisão abaixo de 1 quadro a 59,94).
 *  - landmarks: "impressões digitais" no estilo Shazam/PluralEyes — pares de
 *    picos do espectrograma (freq1, freq2−freq1, Δt) que viram um hash. Dois
 *    arquivos que gravaram o mesmo som compartilham muitos hashes com o mesmo
 *    deslocamento de tempo; é isso que permite comparar 1.000+ clipes sem
 *    testar todos contra todos.
 *
 * O áudio é misturado em mono e reamostrado para 8 kHz (só a faixa de voz
 * interessa). Funciona no Node puro para PCM; AAC/MP3 precisam do
 * decodificador do Chromium (painel CEP), passado como `decode`.
 */
(function (root, factory) {
  const api = factory(root.AEContainers || (typeof require === "function" ? require("../audio/containers.js") : null));
  root.AESyncAudio = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function (Containers) {
  const SR = 8000; // taxa de trabalho
  const WAVE_SR = 4000; // forma de onda guardada para o GCC-PHAT
  const ENV_MS = 2;
  const ENV_N = (SR * ENV_MS) / 1000; // 16 amostras por valor do envelope
  const NFFT = 512; // 64 ms
  const HOP = 256; // 32 ms
  const HOP_SEC = HOP / SR;
  const BINS = NFFT / 2;
  const FMIN_BIN = 4; // ~60 Hz
  const FMAX_BIN = 240; // ~3,75 kHz
  const PEAK_RF = 8; // vizinhança do pico em frequência (bins)
  const PEAK_RT = 4; // vizinhança do pico em tempo (quadros)
  const PEAKS_PER_SEC = 18;
  const FAN_OUT = 6;
  const DT_MAX = 63; // ~2 s
  const DF_MAX = 63;

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
  // ---------------------------------------------------------------- FFT real
  const fftTables = (() => {
    const n = NFFT;
    const rev = new Uint16Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return { rev, cos, sin, win };
  })();

  const fRe = new Float64Array(NFFT);
  const fIm = new Float64Array(NFFT);

  /** Espectro em dB (BINS valores) de NFFT amostras a partir de buf[start]. */
  function spectrumDb(buf, start, out) {
    const { rev, cos, sin, win } = fftTables;
    for (let i = 0; i < NFFT; i++) {
      fRe[rev[i]] = buf[start + i] * win[i];
      fIm[rev[i]] = 0;
    }
    for (let size = 2; size <= NFFT; size <<= 1) {
      const half = size >> 1;
      const step = NFFT / size;
      for (let i = 0; i < NFFT; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tr = fRe[b] * cos[k] - fIm[b] * sin[k];
          const ti = fRe[b] * sin[k] + fIm[b] * cos[k];
          fRe[b] = fRe[a] - tr;
          fIm[b] = fIm[a] - ti;
          fRe[a] += tr;
          fIm[a] += ti;
        }
      }
    }
    for (let k = 0; k < BINS; k++) {
      const p = fRe[k] * fRe[k] + fIm[k] * fIm[k];
      out[k] = p > 1e-12 ? 10 * Math.log10(p) : -120;
    }
  }

  // ------------------------------------------------- extração em fluxo (streaming)
  /**
   * Recebe amostras mono em SR (8 kHz) aos poucos e produz envelope + picos.
   */
  class FeatureSink {
    constructor(expectedSec) {
      const n = Math.ceil(((expectedSec || 60) * 1000) / ENV_MS) + 16;
      this.env = new Float32Array(n);
      this.envLen = 0;
      this.envAcc = 0;
      this.envCount = 0;
      // forma de onda compacta (4 kHz, 8 bits com compressão raiz) para o ajuste fino
      this.wave = new Int8Array(Math.ceil((expectedSec || 60) * WAVE_SR) + 64);
      this.waveLen = 0;
      this.waveAcc = 0;
      this.waveOdd = false;
      // janela da FFT
      this.ring = new Float64Array(NFFT * 2);
      this.ringLen = 0;
      this.frame = 0;
      // buffers de espectro para o filtro de máximo em tempo
      this.specs = []; // { t, db: Float32Array, fmax: Float32Array }
      this.peaks = []; // [t, f, db] achatado
      this.spec = new Float64Array(BINS);
    }
    push(x) {
      // forma de onda 4 kHz (média de 2 amostras de 8 kHz)
      if (this.waveOdd) {
        const v = (this.waveAcc + x) * 0.5;
        if (this.waveLen >= this.wave.length) {
          const bigger = new Int8Array(Math.ceil(this.wave.length * 1.5) + 4096);
          bigger.set(this.wave);
          this.wave = bigger;
        }
        const c = Math.sqrt(Math.min(1, Math.abs(v))) * 127;
        this.wave[this.waveLen++] = v < 0 ? -Math.round(c) : Math.round(c);
      } else this.waveAcc = x;
      this.waveOdd = !this.waveOdd;
      // envelope
      this.envAcc += x * x;
      if (++this.envCount === ENV_N) {
        const ms = this.envAcc / ENV_N;
        if (this.envLen >= this.env.length) {
          const bigger = new Float32Array(Math.ceil(this.env.length * 1.5) + 1024);
          bigger.set(this.env);
          this.env = bigger;
        }
        this.env[this.envLen++] = ms > 1e-12 ? 10 * Math.log10(ms) : -120;
        this.envAcc = 0;
        this.envCount = 0;
      }
      // espectrograma
      this.ring[this.ringLen++] = x;
      if (this.ringLen === NFFT) {
        this.processFrame();
        this.ring.copyWithin(0, HOP, NFFT);
        this.ringLen = NFFT - HOP;
      }
    }
    processFrame() {
      spectrumDb(this.ring, 0, this.spec);
      const db = new Float32Array(BINS);
      for (let k = 0; k < BINS; k++) db[k] = this.spec[k];
      // máximo deslizante em frequência
      const fmax = new Float32Array(BINS);
      for (let k = FMIN_BIN; k < FMAX_BIN; k++) {
        let m = -Infinity;
        const a = Math.max(FMIN_BIN, k - PEAK_RF);
        const b = Math.min(FMAX_BIN - 1, k + PEAK_RF);
        for (let j = a; j <= b; j++) if (db[j] > m) m = db[j];
        fmax[k] = m;
      }
      this.specs.push({ t: this.frame, db, fmax });
      this.frame++;
      if (this.specs.length > 2 * PEAK_RT + 1) this.specs.shift();
      if (this.specs.length === 2 * PEAK_RT + 1) this.pickPeaks(this.specs[PEAK_RT]);
    }
    pickPeaks(center) {
      const { db, fmax, t } = center;
      // limiar: média do quadro + 6 dB
      let mean = 0;
      for (let k = FMIN_BIN; k < FMAX_BIN; k++) mean += db[k];
      mean /= FMAX_BIN - FMIN_BIN;
      for (let k = FMIN_BIN; k < FMAX_BIN; k++) {
        const v = db[k];
        if (v < fmax[k] || v < mean + 6 || v < -60) continue;
        let isMax = true;
        for (const s of this.specs) {
          if (s !== center && s.fmax[k] > v) {
            isMax = false;
            break;
          }
        }
        if (isMax) this.peaks.push(t, k, v);
      }
    }
    finish() {
      // quadros finais não viram centro de vizinhança completa — ignorados (bordas)
      const env = this.env.subarray(0, this.envLen);
      return { env, wave: this.wave.slice(0, this.waveLen), peaks: thinPeaks(this.peaks), frames: this.frame };
    }
  }

  /** Mantém os PEAKS_PER_SEC picos mais fortes em cada segundo. */
  function thinPeaks(flat) {
    const perBlock = Math.round(1 / HOP_SEC);
    const out = [];
    let i = 0;
    while (i < flat.length) {
      const block = Math.floor(flat[i] / perBlock);
      const group = [];
      while (i < flat.length && Math.floor(flat[i] / perBlock) === block) {
        group.push([flat[i], flat[i + 1], flat[i + 2]]);
        i += 3;
      }
      group.sort((a, b) => b[2] - a[2]);
      const keep = group.slice(0, PEAKS_PER_SEC);
      keep.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (const p of keep) out.push(p[0], p[1]);
    }
    return Int32Array.from(out);
  }

  /** Pares de picos -> hashes. Devolve { hash: Uint32Array, t: Uint32Array }. */
  function landmarks(peaks) {
    const n = peaks.length / 2;
    const hash = [];
    const time = [];
    for (let i = 0; i < n; i++) {
      const t1 = peaks[2 * i];
      const f1 = peaks[2 * i + 1];
      let made = 0;
      for (let j = i + 1; j < n && made < FAN_OUT; j++) {
        const dt = peaks[2 * j] - t1;
        if (dt <= 0) continue;
        if (dt > DT_MAX) break;
        const df = peaks[2 * j + 1] - f1;
        if (df < -DF_MAX || df > DF_MAX) continue;
        hash.push(((f1 & 0xff) << 13) | ((df + 64) << 6) | dt);
        time.push(t1);
        made++;
      }
    }
    return { hash: Uint32Array.from(hash), t: Uint32Array.from(time) };
  }

  // ------------------------------------------------------- leitura de arquivo
  /** Mistura para mono e reamostra para SR por média de caixa. */
  class Downmixer {
    constructor(srcRate, sink) {
      this.ratio = SR / srcRate;
      this.sink = sink;
      this.acc = 0;
      this.n = 0;
      this.pos = 0; // posição de saída fracionária
      this.next = 1;
    }
    add(x) {
      this.acc += x;
      this.n++;
      this.pos += this.ratio;
      if (this.pos >= this.next) {
        this.sink.push(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
        this.next++;
      }
    }
  }

  async function readPcm(src, info, sink, onProgress, isCancelled) {
    const ch = info.channels;
    const fb = info.frameBytes;
    const bps = info.bytesPerSample;
    const read = info.read;
    const dm = new Downmixer(info.sampleRate, sink);
    const READ = 4 * 1024 * 1024;
    const lastChunk = info.chunks[info.chunks.length - 1];
    const total = lastChunk ? lastChunk.firstFrame + lastChunk.frames : 0;
    // Começo da mídia (edit list): amostras antes do tempo 0 são puladas
    let skip = Math.max(0, Math.round((info.timeOffsetSec || 0) * info.sampleRate));
    const fast16 = bps === 2;
    const bigEndian = fast16 && read(Buffer.from([0x01, 0x00]), 0) > 0.0078;
    const inv = 1 / ch;
    let done = 0;
    let lastYield = Date.now();

    // Lê chunks vizinhos em blocos contíguos (no MP4 eles vêm intercalados com vídeo)
    const chunks = info.chunks;
    let ci = 0;
    while (ci < chunks.length) {
      let cj = ci;
      let end = chunks[ci].offset + chunks[ci].frames * fb;
      while (cj + 1 < chunks.length && chunks[cj + 1].offset === end && end - chunks[ci].offset < READ) {
        cj++;
        end += chunks[cj].frames * fb;
      }
      // chunks não contíguos mas próximos: lê o vão junto (menos chamadas ao disco)
      const block = src.read(chunks[ci].offset, end - chunks[ci].offset);
      let p = 0;
      for (let c = ci; c <= cj; c++) {
        const frames = Math.min(chunks[c].frames, Math.floor((block.length - p) / fb));
        for (let i = 0; i < frames; i++) {
          const base = p + i * fb;
          let s = 0;
          if (fast16) {
            for (let k = 0; k < ch; k++) {
              const o = base + k * 2;
              let v = bigEndian ? (block[o] << 8) | block[o + 1] : (block[o + 1] << 8) | block[o];
              if (v & 0x8000) v -= 0x10000;
              s += v;
            }
            s = (s * inv) / 32768;
          } else {
            for (let k = 0; k < ch; k++) s += read(block, base + k * bps);
            s *= inv;
          }
          if (skip > 0) {
            skip--;
            continue;
          }
          dm.add(s);
        }
        p += chunks[c].frames * fb;
        done += chunks[c].frames;
      }
      ci = cj + 1;
      if (Date.now() - lastYield > 40) {
        if (onProgress) onProgress(total ? done / total : 0);
        await yieldToUi();
        lastYield = Date.now();
        if (isCancelled && isCancelled()) throw new Error("cancelado");
      }
    }
  }

  async function readDecoded(src, info, sink, decode, onProgress, isCancelled) {
    // Arquivos comprimidos: decodifica em pedaços de 60 s (AAC no MP4) ou inteiro
    const feed = (d, from, to) => {
      const dm = new Downmixer(d.sampleRate, sink);
      const ch = d.channelData.length;
      for (let i = from; i < to; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += d.channelData[c][i];
        dm.add(s / ch);
      }
    };
    if (info.kind === "compressed") {
      const PIECE = 60;
      const off = info.timeOffsetSec || 0;
      for (let t = off; t < info.durationSec; t += PIECE) {
        const end = Math.min(info.durationSec, t + PIECE);
        const slice = Containers.buildCompressedSlice(src, info, t, end, 2);
        if (!slice) break;
        const d = await decode(slice.bytes, info.sampleRate);
        const from = Math.max(0, Math.round((t - slice.startSec) * d.sampleRate));
        const to = Math.min(d.channelData[0].length, Math.round((end - slice.startSec) * d.sampleRate));
        feed(d, from, to);
        if (onProgress) onProgress(end / info.durationSec);
        await yieldToUi();
        if (isCancelled && isCancelled()) throw new Error("cancelado");
      }
      return;
    }
    const d = await decode(src.read(0, src.size), null);
    feed(d, 0, d.channelData[0].length);
  }

  /**
   * Analisa um arquivo inteiro.
   * @returns {Promise<{ durationSec, env: Float32Array, envMs, lm: {hash,t}, hopSec }>}
   */
  async function analyzeFile(filePath, opts) {
    opts = opts || {};
    const media = Containers.openMedia(filePath);
    const { src, info } = media;
    try {
      const dur = info.durationSec || 0;
      const sink = new FeatureSink(dur);
      if (info.kind === "pcm") await readPcm(src, info, sink, opts.onProgress, opts.isCancelled);
      else {
        if (!opts.decode) throw new Error("Este formato precisa do decodificador do painel.");
        await readDecoded(src, info, sink, opts.decode, opts.onProgress, opts.isCancelled);
      }
      const f = sink.finish();
      return {
        durationSec: f.env.length * (ENV_MS / 1000),
        env: f.env,
        envMs: ENV_MS,
        wave: f.wave,
        waveSr: WAVE_SR,
        lm: landmarks(f.peaks),
        peakCount: f.peaks.length / 2,
        hopSec: HOP_SEC,
      };
    } finally {
      src.close();
    }
  }

  return { SR, WAVE_SR, ENV_MS, HOP_SEC, analyzeFile, _internal: { FeatureSink, landmarks, thinPeaks, spectrumDb } };
});
