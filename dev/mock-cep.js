/**
 * mock-cep.js — simula o ambiente CEP + Premiere num navegador comum, só
 * para desenvolver/inspecionar a interface (dev/preview.html). Não vai no ZXP.
 */
(function () {
  const TPS = 254016000000;
  const TB = 8475667200; // 29,97 fps
  const mem = {};
  window.require = (name) => {
    if (name === "fs")
      return {
        mkdirSync() {},
        readFileSync(p) { if (!(p in mem)) throw new Error("ENOENT"); return mem[p]; },
        writeFileSync(p, v) { mem[p] = v; },
        renameSync(a, b) { mem[b] = mem[a]; delete mem[a]; },
        openSync() { throw new Error("sem disco no preview"); },
      };
    if (name === "path") return { join: (...a) => a.join("/"), extname: (p) => (p.match(/\.[^.]+$/) || [""])[0], dirname: (p) => p.replace(/\/[^/]*$/, ""), normalize: (p) => p, basename: (p) => p.replace(/^.*[\\/]/, "") };
    if (name === "os") return { homedir: () => "/home/preview", tmpdir: () => "/tmp", cpus: () => [1, 2, 3, 4] };
    if (name === "crypto") return { createHash: () => ({ update() { return this; }, digest: () => "x" }) };
    throw new Error("módulo indisponível no preview: " + name);
  };
  window.process = { platform: "win32", env: { APPDATA: "/appdata" } };

  const seq = { id: "seq-preview", name: "Depoimento 01", timebase: TB, fps: TPS / TB, end: 26766157017600, playhead: 0, videoTracks: 10, lockedVideoTracks: 0 };
  const tracks = [
    { index: 0, name: "Audio 1", locked: false, muted: false, clips: 1, selected: 0 },
    { index: 1, name: "Audio 2", locked: false, muted: false, clips: 1, selected: 0 },
    { index: 2, name: "Audio 3", locked: false, muted: false, clips: 0, selected: 0 },
    { index: 3, name: "Audio 4", locked: false, muted: false, clips: 0, selected: 0 },
  ];
  const fake = (i, s, e) => ({ id: "c" + i, name: "CHIARO4748.MP4", track: 0, start: s * TB, end: e * TB, inPoint: (s + 106) * TB, outPoint: (e + 106) * TB, speed: 1, reversed: false, disabled: false, selected: false, path: "D:/fake.mp4", mediaEnd: 3330 * TB });
  const ilClips = [];
  let t = 0;
  [177, 735, 52, 177, 95, 162, 269, 146, 120, 393, 142, 328, 100, 192].forEach((d, i) => { ilClips.push(fake(i, t, t + d)); t += d; });
  ilClips[3].inPoint = 2 * TB; // força um corte parcial

  const vTracks = [
    { index: 0, name: "Video 1", locked: false, clips: 10, selected: 1 },
    { index: 1, name: "Video 2", locked: false, clips: 3, selected: 0 },
    { index: 2, name: "Video 3", locked: false, clips: 0, selected: 0 },
  ];
  const vClips = {
    0: Array.from({ length: 10 }, (_, i) => ({ id: "v" + i, name: `Episódio ${i + 1}.mp4`, start: i * 120 * TB, end: (i + 1) * 120 * TB, kind: "video", disabled: i === 7, hasAppZoom: false })),
    1: [
      { id: "g1", name: "Título", start: 0, end: 90 * TB, kind: "graphic", disabled: false, hasAppZoom: false },
      { id: "n1", name: "Logo (aninhada)", start: 300 * TB, end: 400 * TB, kind: "nested", disabled: false, hasAppZoom: false },
      { id: "p1", name: "foto.png", start: 600 * TB, end: 700 * TB, kind: "image", disabled: false, hasAppZoom: false },
    ],
  };
  const api = {
    info: () => ({ project: "copia.prproj", sequence: seq, audioTracks: tracks, videoTracksInfo: vTracks, selectedVideo: { id: "v1", track: 0, name: "Episódio 2.mp4" } }),
    zoomClips: (a) => ({
      tracks: Object.keys(vClips)
        .map(Number)
        .filter((t) => a.scope === "all" || (a.scope === "track" && t === a.track) || a.scope === "selected")
        .map((t) => ({ track: t, name: vTracks[t].name, locked: false, clips: a.scope === "selected" ? vClips[t].filter((c) => c.id === "v1" || c.id === "v2" || c.id === "v3") : vClips[t] }))
        .filter((t) => t.clips.length),
    }),
    zoomApply: (a) => ({ results: a.items.map((it) => { const c = Object.values(vClips).flat().find((x) => x.id === it.id); const had = c && c.hasAppZoom; if (c) c.hasAppZoom = it.needsEffect; return { id: it.id, ok: true, action: it.needsEffect ? (had ? "atualizado" : "aplicado") : had ? "removido (100%)" : "100%" }; }) }),
    zoomRemove: (a) => { let n = 0; a.ids.forEach((id) => { const c = Object.values(vClips).flat().find((x) => x.id === id); if (c && c.hasAppZoom) { c.hasAppZoom = false; n++; } }); return { removed: n, errors: [] }; },
    zoomCapture: (a) => ({ file: "x", url: "/dev/fixture-frame.png", width: 3840, height: 2160, ticks: 130 * TB, name: "Episódio 2.mp4", track: 0, kind: "video" }),
    audioClips: () => ({ clips: [{ id: "a", name: "CHIARO4748.MP4", track: 0, start: 0, end: seq.end, inPoint: 898420723200, outPoint: 27664577740800, speed: 1, reversed: false, disabled: false, selected: false, path: "D:/fixture.mp4" }] }),
    seek: (a) => { seq.playhead = a.ticks; return { ticks: a.ticks }; },
    playhead: () => ({ ticks: seq.playhead, seqId: seq.id }),
    markCuts: (a) => ({ guids: a.cuts.map((_, i) => "g" + i) }),
    backup: (a) => ({ name: a.name, id: "b" }),
    extractCuts: (a) => ({ results: a.cuts.map((c) => ({ start: c.start, ok: true })) }),
    interleaveClips: () => ({ srcClips: ilClips, dstClips: [], timebase: TB }),
    interleaveApply: (a) => ({ results: a.ops.map((o) => ({ id: o.id, moved: o.move, extendStart: o.extendStart, extendEnd: o.extendEnd })) }),
    interleaveUndo: (a) => ({ results: a.ops.map((o) => ({ id: o.id, ok: true })) }),
    // Sincronizar: evento simulado (ver window.__SYNC_WORLD__ em mock-media.js)
    syncInfo: () => {
      const W = window.__SYNC_WORLD__;
      const mk = (dev, linkedTrack) => {
        let t = 0;
        let ai = 0; // índice do áudio vinculado na faixa de áudio
        return dev.clips.map((c, k) => {
          const len = c.to - c.from;
          const o = { id: dev.id + k, name: c.name, start: Math.round(t * TPS), end: Math.round((t + len) * TPS), inPoint: 0, path: c.path, kind: "video", linked: c.noLink || linkedTrack == null ? [] : [[linkedTrack, ai++]], speed: 1, reversed: false };
          t += len;
          return o;
        });
      };
      const v1 = mk(W.devices[0], 0), v2 = mk(W.devices[1], 1), a3 = mk(W.devices[2], null);
      const audioOf = (vs) => vs.filter((c) => c.linked.length).map((c) => ({ id: "a" + c.id, name: c.name, start: c.start, end: c.end, inPoint: 0, path: c.path, disabled: false }));
      return {
        seqId: seq.id, name: seq.name, timebase: TB,
        video: [{ index: 0, name: "Video 1", locked: false, clips: v1 }, { index: 1, name: "Video 2", locked: false, clips: v2 }],
        audio: [
          { index: 0, name: "Audio 1", locked: false, clips: audioOf(v1) },
          { index: 1, name: "Audio 2", locked: false, clips: audioOf(v2) },
          { index: 2, name: "Audio 3", locked: false, clips: a3.map((c) => ({ id: c.id, name: c.name, start: c.start, end: c.end, inPoint: 0, path: c.path, disabled: false })) },
        ],
      };
    },
    syncClone: (a) => ({ id: "seq-sync", name: a.name }),
    syncMove: (a) => ({ moved: a.moves.length, failed: [] }),
    syncOpen: () => ({ ok: true }),
    // Multicâmera: layout de um podcast (geral, 3 câmeras com áudio vinculado, 4 microfones, mix)
    mcInfo: () => {
      const len = 8 * 60 * TPS, cam = (i, name, off) => ({ id: 'v' + i, name, start: off, end: len, inPoint: 0, path: 'D:/podcast/' + name, item: 'it' + i, kind: 'video', linked: [[i, 0]], speed: 1, reversed: false });
      const a = (i, name, off) => ({ id: 'a' + i, name, start: off || 0, end: len, inPoint: 0, path: 'D:/podcast/' + name, item: 'ia' + i, disabled: false });
      const off = Math.round(4.4378 * TPS / TB) * TB;
      return {
        seqId: seq.id, name: 'Podcast (teste)', timebase: TB, end: len, range: null,
        video: [['geral.mp4', 0], ['CAM 1.mp4', off], ['CAM 2.mp4', off], ['CAM 3.mp4', off]].map(([n, o], i) => ({ index: i, name: 'Video ' + (i + 1), locked: false, clips: [cam(i, n, o)] })),
        audio: [['geral.mp4', 0], ['CAM 1.mp4', off], ['CAM 2.mp4', off], ['CAM 3.mp4', off], ['MIC1.wav'], ['MIC2.wav'], ['MIC3.wav'], ['MIC4.wav'], ['mix.wav']].map(([n, o], i) => ({ index: i, name: 'Audio ' + (i + 1), locked: false, clips: [a(i, n, o)] })),
      };
    },
    mcStart: (a) => { window.__MC__ = { n: 0, total: 40 }; return { id: 'seq-mc', name: a.name, total: 40 }; },
    mcStep: () => { const J = window.__MC__; J.n = Math.min(J.total, J.n + 7); return { done: J.n >= J.total, processed: J.n, total: J.total, razors: Math.min(J.n, 30), on: 120, off: 180 }; },
  };
  window.AutomacaoEdicao = {
    call(name, json) {
      try { return JSON.stringify({ ok: true, data: api[name](JSON.parse(json || "{}")) }); }
      catch (e) { return JSON.stringify({ ok: false, error: String(e.message) }); }
    },
  };
  window.__adobe_cep__ = {
    evalScript: (s, cb) => setTimeout(() => cb(eval(s)), 25),
    getSystemPath: () => "file:///C:/preview",
    getHostEnvironment: () => "{}",
    addEventListener() {},
  };
})();
