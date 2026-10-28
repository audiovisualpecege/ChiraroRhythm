// Troca a leitura de disco pelo envelope real gravado em fixture-envelope.js
(function () {
  const f = window.__FIXTURE__;
  const bin = atob(f.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ms = new Float32Array(bytes.buffer);
  AEContainers.openMedia = (p) => ({ path: p, src: { close() {} }, info: { kind: "pcm", durationSec: f.durationSec } });
  const micMs = (name) => {
    const M = window.__MICS__; if (!M || !M.mics[name]) return null;
    const b = atob(M.mics[name]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    const db = new Float32Array(u.buffer), ms = new Float32Array(db.length * 20);
    for (let i = 0; i < db.length; i++) ms.fill(Math.pow(10, db[i] / 10), i * 20, i * 20 + 20);
    return ms;
  };
  AELevels.mediaEnvelope = async (media, from, to, decode, onProgress) => {
    const mic = media && media.path && /MIC\d/.test(media.path) ? micMs(media.path.match(/MIC\d/)[0]) : null;
    if (mic) { onProgress && onProgress(1); const a = Math.max(0, Math.floor(from * 1000)), b = Math.min(mic.length, Math.ceil(to * 1000)); return { startSec: a / 1000, blockMs: 1, ms: mic.slice(a, b) }; }
    const a = Math.max(0, Math.floor(from * 1000));
    const b = Math.min(ms.length, Math.ceil(to * 1000));
    for (let i = 1; i <= 5; i++) { onProgress && onProgress(i / 5); await new Promise((r) => setTimeout(r, 60)); }
    return { startSec: a / 1000, blockMs: 1, ms: ms.slice(a, b) };
  };

  // ---------------------------------------------------- Sincronizar (evento simulado)
  // Um "mundo" sonoro de 10 min (rajadas tipo fala) gravado em partes por duas
  // câmeras e um gravador, cada um com ganho e ruído próprios. O motor real
  // (syncAudio/syncMatch/syncPlan) roda sobre isso no navegador.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const SR = AESyncAudio.SR;
  const WORLD = 600;
  const world = new Float32Array(WORLD * SR);
  let t = 0;
  while (t < world.length) {
    const len = Math.floor((0.08 + rnd() * 0.35) * SR);
    const amp = rnd() < 0.25 ? 0.01 : 0.15 + rnd() * 0.5;
    const f1 = 150 + rnd() * 900, f2 = 1200 + rnd() * 1500;
    for (let i = 0; i < len && t + i < world.length; i++) {
      const env = Math.sin((Math.PI * i) / len);
      world[t + i] = amp * env * (0.6 * Math.sin((2 * Math.PI * f1 * (t + i)) / SR) + 0.4 * Math.sin((2 * Math.PI * f2 * (t + i)) / SR) + 0.3 * (rnd() - 0.5));
    }
    t += len + Math.floor(rnd() * 0.12 * SR);
  }
  const dev = (id, spans, gain, noise, prefix, ext) => ({
    id, gain, noise,
    clips: spans.map(([from, to, extra], k) => Object.assign({ from, to, name: `${prefix}${String(k + 1).padStart(4, "0")}.${ext}`, path: `D:/evento/${id}/${prefix}${k + 1}.${ext}` }, extra || {})),
  });
  window.__SYNC_WORLD__ = {
    devices: [
      dev("cam1", [[10, 70], [80, 150], [160, 200], [400, 460], [470, 520]], 0.7, 0.02, "C", "MP4"),
      dev("cam2", [[30, 100], [150, 260], [330, 360, { noLink: true }], [480, 560]], 0.5, 0.03, "RAFA", "MP4"),
      dev("rec", [[0, 300]], 1.0, 0.005, "ZOOM", "WAV"),
    ],
  };
  const byPath = new Map();
  for (const d of window.__SYNC_WORLD__.devices) for (const c of d.clips) byPath.set(c.path, { d, c });
  AESyncAudio.analyzeFile = async (p, opts) => {
    const { d, c } = byPath.get(p);
    const sink = new AESyncAudio._internal.FeatureSink(c.to - c.from);
    const a = Math.floor(c.from * SR), b = Math.floor(c.to * SR);
    for (let i = a; i < b; i++) {
      sink.push(d.gain * world[i] + d.noise * (rnd() - 0.5));
      if ((i - a) % 200000 === 0) { opts && opts.onProgress && opts.onProgress((i - a) / (b - a)); await new Promise((r) => setTimeout(r, 0)); }
    }
    const f = sink.finish();
    // relógio de cada aparelho com um erro próprio (dia/hora trocados), como na vida real
    const clockError = { cam1: -86400 + 37, cam2: 12, rec: -3 * 365 * 86400 };
    const clock = 1.8e9 + c.from + clockError[d.id];
    return { durationSec: f.env.length * (AESyncAudio.ENV_MS / 1000), env: f.env, envMs: AESyncAudio.ENV_MS, wave: f.wave, waveSr: AESyncAudio.WAVE_SR, lm: AESyncAudio._internal.landmarks(f.peaks), hopSec: AESyncAudio.HOP_SEC, clock };
  };
})();
