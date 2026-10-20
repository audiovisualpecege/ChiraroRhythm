/**
 * Testes da lógica pura (sem Premiere): node test/run-tests.js
 * Opcional: AE_REAL_MEDIA="caminho1;caminho2" testa a leitura de arquivos reais.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const base = path.join(__dirname, "..", "extension", "js");
const C = require(path.join(base, "audio", "containers.js"));
const L = require(path.join(base, "audio", "levels.js"));
const S = require(path.join(base, "audio", "silence.js"));
const P = require(path.join(base, "tools", "interleavePlan.js"));

const TPS = 254016000000;
const TB = 8475667200; // 29,97
const FPS = TPS / TB;
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- WAV sintético
/** segments: [{ sec, amp }] tom de 220 Hz com amplitude amp (0 = silêncio + ruído leve) */
function makeWav(file, { sr = 48000, ch = 2, bits = 16, float = false, segments }) {
  const frames = segments.reduce((n, s) => n + Math.round(s.sec * sr), 0);
  const bps = bits / 8;
  const data = Buffer.alloc(frames * ch * bps);
  let f = 0;
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.001;
  for (const s of segments) {
    const n = Math.round(s.sec * sr);
    for (let i = 0; i < n; i++, f++) {
      const v = s.amp * Math.sin((2 * Math.PI * 220 * f) / sr) + noise();
      for (let c = 0; c < ch; c++) {
        const o = (f * ch + c) * bps;
        const vc = c === 0 ? v : v * 0.5;
        if (float) data.writeFloatLE(vc, o);
        else if (bits === 16) data.writeInt16LE(Math.round(vc * 32767), o);
        else if (bits === 24) data.writeIntLE(Math.round(vc * 8388607), o, 3);
      }
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(float ? 3 : 1, 20);
  h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * ch * bps, 28);
  h.writeUInt16LE(ch * bps, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ae-test-"));
const pattern = [
  { sec: 2, amp: 0.3 }, // fala 0-2
  { sec: 1, amp: 0 }, // silêncio 2-3
  { sec: 2, amp: 0.3 }, // fala 3-5
  { sec: 0.3, amp: 0 }, // pausa curta 5-5.3 (abaixo do mínimo)
  { sec: 1.7, amp: 0.3 }, // fala 5.3-7
  { sec: 1.5, amp: 0 }, // silêncio final 7-8.5
];

async function analyzeFile(file, from = 0, to = 8.5) {
  const m = C.openMedia(file);
  const env = await L.mediaEnvelope(m, from, to, null);
  m.src.close();
  return S.buildTimeline([{ tStart: 0, tEnd: to - from, srcIn: from, speed: 1, env }], 0, to - from);
}

const params = { thresholdDb: -40, windowMs: 20, minSilenceSec: 0.5, marginAfterMs: 100, marginBeforeMs: 100, fps: FPS };
const near = (a, b, tol = 1 / FPS + 0.021) => Math.abs(a - b) <= tol;

for (const fmt of [{ bits: 16 }, { bits: 24 }, { bits: 32, float: true }, { bits: 16, ch: 1, sr: 44100 }]) {
  test(`WAV ${fmt.bits}-bit${fmt.float ? " float" : ""} ${fmt.sr || 48000} Hz ${fmt.ch || 2}ch: detecta os silêncios certos`, async () => {
    const file = path.join(tmp, `t${fmt.bits}${fmt.float ? "f" : ""}${fmt.ch || 2}.wav`);
    makeWav(file, { ...fmt, segments: pattern });
    const tl = await analyzeFile(file);
    const { cuts } = S.detect(tl, params);
    assert.strictEqual(cuts.length, 2, `esperava 2 cortes, veio ${cuts.length}`);
    assert(near(cuts[0].startSec, 2.1) && near(cuts[0].endSec, 2.9), `corte 1: ${cuts[0].startSec}-${cuts[0].endSec}`);
    // silêncio no fim do trecho: sem margem "antes da fala" (não há fala depois)
    assert(near(cuts[1].startSec, 7.1) && near(cuts[1].endSec, 8.5), `corte 2: ${cuts[1].startSec}-${cuts[1].endSec}`);
    cuts.forEach((c) => assert(Number.isInteger(c.startFrame) && Number.isInteger(c.endFrame)));
  });
}

test("in point no meio do arquivo: tempos relativos à timeline", async () => {
  const file = path.join(tmp, "t162.wav");
  const tl = await analyzeFile(file, 1, 8.5); // clipe começa no segundo 1 da mídia
  const { cuts } = S.detect(tl, params);
  assert(near(cuts[0].startSec, 1.1) && near(cuts[0].endSec, 1.9), `${cuts[0].startSec}-${cuts[0].endSec}`);
});

test("sugestão automática fica entre ruído e fala", async () => {
  const tl = await analyzeFile(path.join(tmp, "t162.wav"));
  const s = S.suggestThresholdDb(tl, 20);
  assert(s.thresholdDb > s.noiseDb && s.thresholdDb < s.speechDb, JSON.stringify(s));
});

test("faixas permitidas (clipes selecionados) limitam os cortes", async () => {
  const tl = await analyzeFile(path.join(tmp, "t162.wav"));
  const { cuts } = S.detect(tl, { ...params, allowed: [{ startSec: 6, endSec: 8.5 }] });
  assert.strictEqual(cuts.length, 1);
  assert(near(cuts[0].startSec, 7.1));
});

test("clipe ilegível (keep) nunca é cortado", () => {
  const tl = S.buildTimeline([{ tStart: 0, tEnd: 5, keep: true }], 0, 5);
  assert.strictEqual(S.detect(tl, params).cuts.length, 0);
});

test("buraco sem clipe conta como silêncio", () => {
  const env = { startSec: 0, ms: new Float32Array(1000).fill(0.01) }; // -20 dB, 1 s
  const tl = S.buildTimeline(
    [
      { tStart: 0, tEnd: 1, srcIn: 0, speed: 1, env },
      { tStart: 3, tEnd: 4, srcIn: 0, speed: 1, env },
    ],
    0,
    4
  );
  const { cuts } = S.detect(tl, params);
  assert.strictEqual(cuts.length, 1);
  assert(near(cuts[0].startSec, 1.1) && near(cuts[0].endSec, 2.9));
});

// ---------------------------------------------------------------- Intercalado
const clip = (id, s, e, inF, opts = {}) => ({ id, name: id, start: s * TB, end: e * TB, inPoint: inF * TB, outPoint: (inF + e - s) * TB, speed: 1, reversed: false, mediaEnd: 100000 * TB, ...opts });

test("intercalado: alterna faixas e estica os dois lados", () => {
  const src = [clip("a", 0, 100, 50), clip("b", 100, 200, 300), clip("c", 200, 300, 600)];
  const p = P.plan({ srcTrack: 0, dstTrack: 1, type: "both", frames: 6, timebase: TB, srcClips: src, dstClips: [] });
  assert(p.ok);
  assert.deepStrictEqual(p.ops.map((o) => o.move), [false, true, false]);
  assert.strictEqual(p.ops[0].extendEnd, 6 * TB);
  assert.strictEqual(p.ops[1].extendStart, 6 * TB);
  assert.strictEqual(p.ops[0].extendStart, 0); // primeiro clipe não tem J
  assert.strictEqual(p.ops[2].extendEnd, 0); // último não tem L
  assert.strictEqual(p.summary.full, 2);
});

test("intercalado: sem handle estica o possível e marca parcial", () => {
  const src = [clip("a", 0, 100, 50, { mediaEnd: 152 * TB }), clip("b", 100, 200, 3)];
  const p = P.plan({ srcTrack: 0, dstTrack: 1, type: "both", frames: 6, timebase: TB, srcClips: src, dstClips: [] });
  assert.strictEqual(p.ops[0].extendEnd, 2 * TB); // só 2 frames de mídia depois do out
  assert.strictEqual(p.ops[1].extendStart, 3 * TB); // in point no frame 3
  assert.strictEqual(p.summary.partial, 1);
  assert.strictEqual(p.summary.partialList[0].gotFrames, 5);
});

test("intercalado: J-cut só estica o início", () => {
  const src = [clip("a", 0, 100, 50), clip("b", 100, 200, 300)];
  const p = P.plan({ srcTrack: 0, dstTrack: 1, type: "J", frames: 8, timebase: TB, srcClips: src, dstClips: [] });
  assert.strictEqual(p.ops[0].extendEnd, 0);
  assert.strictEqual(p.ops[1].extendStart, 8 * TB);
});

test("intercalado: destino ocupado é recusado sem mexer em nada", () => {
  const src = [clip("a", 0, 100, 50), clip("b", 100, 200, 300)];
  const p = P.plan({ srcTrack: 0, dstTrack: 1, type: "both", frames: 6, timebase: TB, srcClips: src, dstClips: [{ id: "x", name: "x", start: 150 * TB, end: 160 * TB }] });
  assert(!p.ok && p.conflicts.length === 1);
});

test("intercalado: clipe curto no meio limita J+L na mesma faixa", () => {
  // b tem só 4 frames: a(L) e c(J) ficam na mesma faixa separados por 4 frames
  const src = [clip("a", 0, 100, 50), clip("b", 100, 104, 300), clip("c", 104, 200, 600)];
  const p = P.plan({ srcTrack: 0, dstTrack: 1, type: "both", frames: 6, timebase: TB, srcClips: src, dstClips: [] });
  assert(p.ops[0].extendEnd + p.ops[2].extendStart <= 4 * TB);
});

test("intercalado: origem e destino iguais", () => {
  const p = P.plan({ srcTrack: 0, dstTrack: 0, type: "both", frames: 6, timebase: TB, srcClips: [clip("a", 0, 1, 0), clip("b", 1, 2, 0)], dstClips: [] });
  assert(!p.ok);
});

// ---------------------------------------------------------------- Zoom
const Z = require(path.join(base, "tools", "zoomPlan.js"));
const zs = (o = {}) => ({ mainScale: 125, secondEnabled: false, secondScale: 115, startWithZoom: false, focusX: 0.5, focusY: 0.5, mode: "fixed", direction: "in", intensity: 3, ...o });
const zclips = (n) => Array.from({ length: n }, (_, i) => ({ id: "c" + i, start: i }));

test("zoom: ciclo 100/125 e ciclo de 3 com a segunda escala", () => {
  assert.deepStrictEqual(Z.plan([{ track: 0, clips: zclips(4) }], zs()).map((i) => i.scale), [100, 125, 100, 125]);
  assert.deepStrictEqual(Z.plan([{ track: 0, clips: zclips(5) }], zs({ secondEnabled: true })).map((i) => i.scale), [100, 125, 115, 100, 125]);
});

test("zoom: começar com zoom avança o ciclo", () => {
  assert.deepStrictEqual(Z.plan([{ track: 0, clips: zclips(4) }], zs({ secondEnabled: true, startWithZoom: true })).map((i) => i.scale), [125, 115, 100, 125]);
});

test("zoom: cada faixa conta separado, em ordem de tempo", () => {
  const items = Z.plan([{ track: 0, clips: zclips(3) }, { track: 1, clips: [{ id: "b", start: 9 }, { id: "a", start: 1 }] }], zs());
  assert.deepStrictEqual(items.filter((i) => i.track === 1).map((i) => [i.id, i.scale]), [["a", 100], ["b", 125]]);
});

test("zoom: 100% fixo não precisa de efeito; em movimento precisa", () => {
  const fixed = Z.plan([{ track: 0, clips: zclips(2) }], zs());
  assert.deepStrictEqual(fixed.map((i) => i.needsEffect), [false, true]);
  const moving = Z.plan([{ track: 0, clips: zclips(2) }], zs({ mode: "moving" }));
  assert.deepStrictEqual(moving.map((i) => [i.scaleStart, i.scaleEnd]), [[100, 103], [125, 128]]);
  assert(moving.every((i) => i.needsEffect));
});

test("zoom: zoom out e alternar", () => {
  assert.deepStrictEqual(Z.plan([{ track: 0, clips: zclips(2) }], zs({ mode: "moving", direction: "out" })).map((i) => [i.scaleStart, i.scaleEnd]), [[103, 100], [128, 125]]);
  assert.deepStrictEqual(Z.plan([{ track: 0, clips: zclips(2) }], zs({ mode: "moving", direction: "alternate" })).map((i) => [i.scaleStart, i.scaleEnd]), [[100, 103], [128, 125]]);
});

test("zoom: a mira fica parada na tela e nunca mostra borda acima de 100%", () => {
  for (const s of [100, 115, 125, 200]) {
    for (const f of [0, 0.3, 0.5, 1]) {
      const [px] = Z.positionFor(s, f, f);
      const k = s / 100;
      assert(Math.abs(px + (f - 0.5) * k - f) < 1e-12, "mira fixa");
      assert(px - 0.5 * k <= 1e-12 && px + 0.5 * k >= 1 - 1e-12, `sem borda em ${s}% mira ${f}`);
    }
  }
});

// ---------------------------------------------------------------- sincronizar: cópia por FCP XML
const SX = require(path.join(base, "sync", "syncXml.js"));
{
  const TB60 = (TPS * 1001) / 60000; // 59,94
  const clipXml = (id, s, e) =>
    `<clipitem id="${id}"><name>${id}</name><start>${s}</start><end>${e}</end><in>0</in><out>${e - s}</out>` +
    `<file id="f-${id}"><media><video><samplecharacteristics><rate><timebase>60</timebase></rate></samplecharacteristics></video></media></file></clipitem>`;
  const xmlOf = (clips) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1"><uuid>aaa</uuid><duration>300</duration>` +
    `<rate><timebase>60</timebase><ntsc>TRUE</ntsc></rate><name>Geral</name><media>` +
    `<video><format><samplecharacteristics><rate><timebase>60</timebase></rate></samplecharacteristics></format><track>${clips.map(([s, e], i) => clipXml("v" + i, s, e)).join("")}</track></video>` +
    `<audio><track currentExplodedTrackIndex="0" totalExplodedTrackCount="2">${clips.map(([s, e], i) => clipXml("aL" + i, s, e)).join("")}</track>` +
    `<track currentExplodedTrackIndex="1" totalExplodedTrackCount="2">${clips.map(([s, e], i) => clipXml("aR" + i, s, e)).join("")}</track></audio>` +
    `</media></sequence></xmeml>`;
  const siOf = (clips) => {
    const list = clips.map(([s, e]) => ({ start: s * TB60, end: e * TB60 }));
    return { timebase: TB60, video: [{ clips: list }], audio: [{ clips: list }] };
  };
  const starts = (xml) => [...xml.matchAll(/<start>(-?\d+)<\/start>/g)].map((m) => Number(m[1]));

  test("sincronizar XML: move vídeo e os dois canais do áudio, renomeia e atualiza a duração", () => {
    const clips = [[0, 100], [100, 300]];
    const r = SX.rewrite(xmlOf(clips), siOf(clips), [
      { v: 1, t: 0, i: 1, to: 500 * TB60 },
      { v: 0, t: 0, i: 1, to: 500 * TB60 },
      { v: 1, t: 0, i: 0, to: 0 },
    ], { name: "Geral (Sincronizada) & cia", uuid: "bbb" });
    assert.deepStrictEqual(starts(r.xml), [0, 500, 0, 500, 0, 500]);
    assert(r.xml.includes("<end>700</end>"));
    assert(r.xml.includes("<duration>700</duration>") && r.xml.includes("<uuid>bbb</uuid>"));
    assert(r.xml.includes("<name>Geral (Sincronizada) &amp; cia</name>"));
    assert.strictEqual(r.changed, 2);
  });

  test("sincronizar XML: sequência 'quase 29,97' aceita XML 30 NTSC (conta na grade da sequência)", () => {
    const TBq = 8475726470; // medido no Premiere 26.5 (13/10)
    const clips = [[0, 100], [100, 300]];
    const x30 = xmlOf(clips).replace(/<timebase>60<\/timebase><ntsc>TRUE<\/ntsc>/, "<timebase>30</timebase><ntsc>TRUE</ntsc>");
    const si = { timebase: TBq, video: [{ clips: clips.map(([s, e]) => ({ start: s * TBq, end: e * TBq })) }], audio: [{ clips: clips.map(([s, e]) => ({ start: s * TBq, end: e * TBq })) }] };
    const r = SX.rewrite(x30, si, [{ v: 1, t: 0, i: 1, to: 500 * TBq }, { v: 0, t: 0, i: 1, to: 500 * TBq }], { name: "x", uuid: "c" });
    assert.deepStrictEqual(starts(r.xml), [0, 500, 0, 500, 0, 500]);
    // clipe a ~1h27: o XML do Premiere (segundos → 30 NTSC) diverge da grade da sequência em ~1 quadro;
    // aceita, e TODOS os clipes (até o que não se move) saem na grade da sequência
    const far = [[0, 100], [156383, 156483]]; // quadros na grade da sequência
    const xmlFrames = (f) => Math.round((f * TBq) / ((TPS * 1001) / 30000));
    const xFar = xmlOf(far.map(([s, e]) => [xmlFrames(s), xmlFrames(s) + (e - s)])).replace(/<timebase>60<\/timebase><ntsc>TRUE<\/ntsc>/, "<timebase>30</timebase><ntsc>TRUE</ntsc>");
    assert.notStrictEqual(xmlFrames(156383), 156383);
    const siFar = { timebase: TBq, video: [{ clips: far.map(([s, e]) => ({ start: s * TBq, end: e * TBq })) }], audio: [{ clips: far.map(([s, e]) => ({ start: s * TBq, end: e * TBq })) }] };
    const rf = SX.rewrite(xFar, siFar, [{ v: 1, t: 0, i: 0, to: 10 * TBq }], { name: "x", uuid: "d" });
    assert.deepStrictEqual(starts(rf.xml), [10, 156383, 0, 156383, 0, 156383]);
    // taxa realmente diferente continua recusada
    assert.throws(() => SX.rewrite(xmlOf(clips).replace("<timebase>60</timebase><ntsc>TRUE</ntsc>", "<timebase>25</timebase><ntsc>FALSE</ntsc>"), si, [], { name: "x" }), /Taxa do XML/);
  });

  test("sincronizar XML: recusa XML que não bate com a sequência", () => {
    const clips = [[0, 100], [100, 300]];
    const si = siOf(clips);
    si.video[0].clips[1].start += TB60;
    assert.throws(() => SX.rewrite(xmlOf(clips), si, [], { name: "x" }), /não bate/);
    assert.throws(() => SX.rewrite(xmlOf(clips), siOf([[0, 100]]), [], { name: "x" }), /clipe\(s\) no XML/);
    assert.throws(() => SX.rewrite(xmlOf(clips), siOf(clips), [{ v: 1, t: 0, i: 0, to: 10.5 * TB60 }], { name: "x" }), /quadro inteiro/);
  });
}

// ---------------------------------------------------------------- sincronizar por imagem (boca × voz)
const SV = require(path.join(base, "sync", "syncVisualMatch.js"));
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  // "fala": ruído suavizado (sílabas ~ 4–6 quadros)
  const speech = (n) => { const x = new Float32Array(n); let v = 0; for (let i = 0; i < n; i++) { v = 0.75 * v + rnd(); x[i] = v; } return x; };

  test("imagem: correlação por FFT igual à conta direta, ignorando quadros sem rosto", () => {
    const b = speech(3000), a = speech(400);
    for (let i = 50; i < 90; i++) a[i] = NaN;
    const T = SV.prepareTarget(b, a.length);
    const c = SV.xcorrNorm(a, T);
    const direct = (L) => {
      const idx = []; a.forEach((v, i) => { if (!Number.isNaN(v)) idx.push(i); });
      const n = idx.length, m = idx.reduce((s, i) => s + a[i], 0) / n;
      const sd = Math.sqrt(idx.reduce((s, i) => s + (a[i] - m) ** 2, 0) / n);
      let sy = 0, syy = 0, sxy = 0;
      for (const i of idx) { const y = b[L + i]; sy += y; syy += y * y; sxy += ((a[i] - m) / sd) * y; }
      return sxy / n / Math.sqrt(syy / n - (sy / n) ** 2);
    };
    for (const L of [0, 1, 777, 2600]) assert(Math.abs(c[L] - direct(L)) < 1e-4, `L=${L}: ${c[L]} × ${direct(L)}`);
    assert.strictEqual(c.length, 3000 - 400 + 1);
  });

  test("imagem: acha o deslocamento da boca no gravador, com ruído e buracos", () => {
    const fps = 29.97, rec = speech(40000), L0 = 23456;
    const mouth = new Float32Array(3600);
    for (let i = 0; i < mouth.length; i++) mouth[i] = (i % 97 < 12) ? NaN : rec[L0 + i] + rnd() * 2.5;
    const T = SV.prepareTarget(SV.highpass(rec, 15), mouth.length);
    const r = SV.matchWindow(mouth, 300, T, fps); // janela começa em 300 s da câmera
    assert(Math.abs((r.D + 300) * fps - L0) < 0.6, `D=${r.D}`);
    assert(r.ratio > 1.5, `razão ${r.ratio}`);
  });

  test("imagem: envelope por quadro a partir do envelope de 2 ms", () => {
    const env = new Float32Array(1000).fill(-60);
    for (let i = 500; i < 1000; i++) env[i] = -20; // 1 s de silêncio, 1 s de som
    const e = SV.frameEnvelope(env, 2, 25);
    assert.strictEqual(e.length, 50);
    assert(Math.abs(e[10] + 6) < 1e-3 && Math.abs(e[40] + 2) < 1e-3);
  });

  test("imagem: trechos com mais fala, sem sobreposição", () => {
    const scan = [];
    for (let t = 0; t < 1200; t++) scan.push({ t, open: [t >= 600 && t < 800 && t % 2 ? 0.08 : 0.01, t >= 100 && t < 200 ? 0.07 : 0.0] });
    const w = SV.speechWindows(scan, 1200, { winSec: 120, maxWindows: 3 });
    assert.strictEqual(w[0].person, 1);
    assert(w[0].start >= 80 && w[0].start <= 100);
    assert(w.some((x) => x.person === 0 && x.start >= 600 && x.end <= 820));
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) assert(w[i].end <= w[j].start || w[j].end <= w[i].start);
  });

  test("imagem: decisão — consenso vira Lavanda, janela fraca sozinha vira revisar, ruído é nada", () => {
    const fps = 30;
    assert.strictEqual(SV.decide([{ D: -0.64, ratio: 1.55 }, { D: -0.66, ratio: 1.6 }, { D: 900, ratio: 1.1 }], fps).level, "synced");
    assert.strictEqual(SV.decide([{ D: -0.64, ratio: 1.55 }], fps).level, "review");
    assert.strictEqual(SV.decide([{ D: -0.64, ratio: 2.0 }], fps).level, "synced");
    assert.strictEqual(SV.decide([{ D: -0.64, ratio: 1.1 }, { D: 30, ratio: 1.2 }], fps), null);
    // duas janelas fortes discordando: não confia
    assert.strictEqual(SV.decide([{ D: -0.64, ratio: 2.0 }, { D: 50, ratio: 1.9 }], fps).level, "review");
  });

  test("imagem: consenso — janelas fracas no mesmo quadro achadas; janelas que não concordam, nada", () => {
    const fps = 30, len = 140000; // ~78 min de posições
    const noise = (w, base) => Array.from({ length: 10 }, (_, i) => ({ D: base + 37 * i + w * 11, z: 6 - i * 0.3 }));
    // 3 janelas: o acerto (4,40 s) nunca é o 1º pico, mas está entre os maiores em todas
    const sets = [0, 1, 2].map((w) => ({ w, len, peaks: noise(w, 300 + w * 500).slice(0, 7).concat({ D: 4.40 + w * 0.02, z: 4.5 }) }));
    const c = SV.consensus(sets, fps);
    assert(c && c.k === 3 && Math.abs(c.D - 4.42) < 0.03, JSON.stringify(c));
    // decisão: nada antes → Lavanda com 3 janelas; com 2 janelas → revisar; com o decide já no mesmo lugar → Lavanda
    assert.strictEqual(SV.withConsensus(null, Object.assign(c, { target: "g" }), [], fps).level, "synced");
    const c2 = Object.assign(SV.consensus(sets.slice(0, 2), fps), { target: "g" });
    assert(c2.k === 2 && c2.E2 < 0.05, JSON.stringify(c2));
    assert.strictEqual(SV.withConsensus(null, c2, [], fps).level, "review");
    assert.strictEqual(SV.withConsensus({ D: 4.41, ratio: 1.5, level: "review", target: "g" }, c2, [], fps).level, "synced");
    // janela forte no mesmo gravador apontando outro lugar → no máximo revisar
    assert.strictEqual(SV.withConsensus(null, c, [{ D: 900, ratio: 2.1, target: "g" }], fps).level, "review");
    // Lavanda do decide não é mexida
    const lav = { D: -0.6, ratio: 2, level: "synced", target: "g" };
    assert.strictEqual(SV.withConsensus(lav, c, [], fps), lav);
    // janelas sem nenhum pico em comum → nada
    assert.strictEqual(SV.consensus([0, 1, 2].map((w) => ({ w, len, peaks: noise(w, 300 + w * 5000) })), fps), null);
    // gravação curta (tomada de 60 s): 2 janelas não bastam — o acaso explicaria
    const short = SV.consensus(sets.slice(0, 2).map((s) => Object.assign({}, s, { len: 1800 })), fps);
    assert(short.E2 > 0.05 && SV.withConsensus(null, Object.assign(short, { target: "g" }), [], fps) === null);
  });
}

// ---------------------------------------------------------------- claquete reconhecida (referência)
const SLT = require(path.join(base, "sync", "syncSlate.js"));
test("claquete reconhecida: espelho alto só com a ripa fechada (inclusive inclinada); batida = fecha e fica", () => {
  // barras listradas: W×H RGB, corpo em (40, 60), largura 200 → barra ≈ 21 px; contato em y = 60 − 21
  const W = 280, H = 120, bx = 40, by = 60, bw = 200, b = Math.round(0.107 * bw), yc = by - b;
  const draw = (closed, deg) => {
    const img = new Uint8Array(W * H * 3).fill(90);
    const sl = Math.tan((deg * Math.PI) / 180), xm = bx + 0.625 * bw;
    for (let x = bx; x < bx + bw; x++) {
      const y0 = Math.round(yc + (x - xm) * sl);
      for (let k = 0; k < b; k++) {
        // listras diagonais: a de baixo "/" e a de cima o reflexo "\" — chevron
        const lo = ((x + k) >> 3) & 1, up = ((x + k) >> 3) & 1;
        const yl = y0 + k, yu = y0 - 1 - k;
        if (yl < H) for (let c = 0; c < 3; c++) img[3 * (yl * W + x) + c] = lo ? 230 - 40 * c : 20 + 30 * c;
        if (closed && yu >= 0) for (let c = 0; c < 3; c++) img[3 * (yu * W + x) + c] = up ? 230 - 40 * c : 20 + 30 * c;
        else if (yu >= 0) for (let c = 0; c < 3; c++) img[3 * (yu * W + x) + c] = 90 + ((x * 7 + k * 13) % 23);
      }
    }
    return img;
  };
  const open = SLT.mirror(draw(false, 0), W, H, bx, by, bw), closed = SLT.mirror(draw(true, 0), W, H, bx, by, bw);
  const tilted = SLT.mirror(draw(true, 10), W, H, bx, by, bw);
  assert(closed > 0.9 && tilted > 0.85 && open < 0.5, `aberta ${open} · fechada ${closed} · inclinada ${tilted}`);
  // série: aberta (0,5) → fecha e FICA (0,95) → sai de cena; antes, um ensaio que reabre
  const fps = 30, rows = [];
  const shown = new Array(26).fill(0.5); // claquete mostrada ~0,9 s antes de tudo
  const seq = shown.concat([0.95, 0.95, 0.95, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.7, 0.95, 0.96, 0.95, 0.94, 0.95]);
  seq.forEach((m, i) => rows.push({ t: i / fps, score: 0.6, m }));
  rows.push({ t: seq.length / fps, score: 0, m: null });
  const hit = SLT.findClap(rows, fps);
  assert(hit && Math.abs(hit.t - (38 - 0.5) / fps) < 1e-9, `batida ${hit && hit.t * fps} q (esperado 37,5: o ensaio no q 26 reabre)`);
  // sem claquete bem encaixada antes (só seguimento no borrão) → nada
  assert.strictEqual(SLT.findClap(rows.map((r) => Object.assign({}, r, { score: 0.4 })), fps), null);
  // claquete de relance (0,4 s em cena) que "fecha" → nada
  const glimpse = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95].map((m, i) => ({ t: i / fps, score: 0.6, m }));
  assert.strictEqual(SLT.findClap(glimpse, fps), null);
});

// ---------------------------------------------------------------- claquete (imagem × gravador)
const CL = require(path.join(base, "sync", "syncClap.js"));
{
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  test("claquete: acha a batida (para de repente depois de parada), não a retirada logo depois", () => {
    const W = 240, H = 132, fps = 30000 / 1001, f0 = 40;
    const tex = Uint8Array.from({ length: W * H }, () => 40 + rnd() * 160);
    const stickY = (f) => (f < f0 - 3 ? 10 : f === f0 - 3 ? 12 : f === f0 - 2 ? 15 : f === f0 - 1 ? 19 : 24);
    const sink = new CL.VisualClapSink(W, H);
    for (let f = 0; f < 120; f++) {
      const g = new Uint8Array(W * H);
      for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, tex[i] + (rnd() - 0.5) * 4));
      // tirar a claquete: desliza para a direita a partir de f0+15 e some em f0+27
      const dx = f > f0 + 15 ? (f - f0 - 15) * 12 : 0;
      if (f < f0 + 27) {
        for (let y = 36; y < 96; y++) for (let x = 60 + dx; x < Math.min(W, 156 + dx); x++) g[y * W + x] = 215; // quadro
        const sy = stickY(f);
        for (let y = sy; y < sy + 12; y++) for (let x = 60 + dx; x < Math.min(W, 156 + dx); x++) g[y * W + x] = ((x >> 3) & 1) ? 20 : 235; // ripa listrada
      }
      sink.push(g, 100 + f / fps); // arquivo começa em 100 s (start ≠ 0)
    }
    const r = sink.result(fps);
    assert(r, "não achou a batida");
    assert.strictEqual(r.frame, f0);
    assert(Math.abs(r.t - (100 + (f0 - 0.5) / fps)) < 1e-6, `t=${r.t}`);
  });

  test("claquete: estalo do gravador sim, vogal longa e batida fraca não", () => {
    const env = new Float32Array(5000).map(() => -60 + rnd()); // 10 s de 2 ms
    const put = (t0, ms, f) => { for (let k = 0; k < ms / 2; k++) env[t0 / 2 + k] = f(k * 2); };
    put(3000, 140, (ms) => (ms < 20 ? -20 : -20 - (ms - 20) * 0.3)); // estalo: sobe 40 dB e morre
    put(5000, 400, () => -25); // vogal: sobe forte mas não cai
    put(8000, 30, () => -45); // batida fraca: +15 dB
    const c = CL.recorderClaps(env, 2);
    assert.strictEqual(c.length, 1, JSON.stringify(c));
    assert(Math.abs(c[0].t - 3.0) < 0.004 && c[0].decay > 25);
  });

  test("claquete: a boca escolhe entre estalos só quando um se destaca", () => {
    const fps = 30, corr = new Float32Array(3000).fill(0.02);
    corr[600] = 0.4; corr[1500] = 0.1;
    // série começa em 10 s da câmera; D = L/fps − 10
    const r = CL.pickByMouth(corr, 10, fps, [1500 / fps - 10, 601 / fps - 10]);
    assert.strictEqual(r.i, 1);
    corr[1500] = 0.35; // empate → não decide
    assert.strictEqual(CL.pickByMouth(corr, 10, fps, [1500 / fps - 10, 600 / fps - 10]), null);
  });
}

{
  test("claquete: tomadas pela ordem e duração (pula arquivo extra e tomada sem câmera)", () => {
    // câmera: extra curto no começo, 3 tomadas; gravador: 4 tomadas (a 3ª sem câmera)
    const cam = [10, 75, 85, 340, 30];
    const rec = [59, 89, 33, 343, 31];
    const r = CL.alignTakes(cam, rec);
    assert.deepStrictEqual(r.take, [-1, 0, 1, 3, 4]);
  });

  test("claquete: na tomada certa, 1º evento parecido com batida × estalo do começo", () => {
    const events = [{ t: 2.0, quiet: 0.9 }, { t: 7.5, quiet: 0.2 }, { t: 9.0, quiet: 0.1 }];
    const claps = [{ t: 6.4, jump: 32 }, { t: 400, jump: 35 }];
    const p = CL.clapInTake(events, claps);
    assert(Math.abs(p.D - (6.4 - 7.5)) < 1e-9 && p.t === 7.5);
    assert.strictEqual(CL.clapInTake([{ t: 3, quiet: 0.8 }], claps), null);
  });

  test("claquete: boca confirma só quando o pico dela cai na claquete", () => {
    const fps = 30, corr = new Float32Array(2000).fill(0.03);
    corr[900] = 0.3; corr[1500] = 0.2;
    assert.strictEqual(CL.confirmByMouth(corr, 10, fps, 900 / fps - 10).ok, true);
    assert.strictEqual(CL.confirmByMouth(corr, 10, fps, 1500 / fps - 10).ok, false);
  });
}

// ---------------------------------------------------------------- atualização (botão do painel)
{
  const U = require(path.join(base, "core", "updater.js"));
  const rel = (tag, extra = {}) => Object.assign({
    tag_name: tag, draft: false, prerelease: false, body: "notas", html_url: "https://x/rel",
    assets: [{ name: `Rhythm-${U.shortVersion(tag.replace(/^v/, ""))}.exe`, browser_download_url: "http://x/a.exe", size: 10 }],
  }, extra);

  test("atualização: compara versões e encurta o nome", () => {
    assert.strictEqual(U.compareVersions("3.0.0", "2.9.1"), 1);
    assert.strictEqual(U.compareVersions("v3.0", "3.0.0"), 0);
    assert.strictEqual(U.compareVersions("3.0.1", "3.0.10"), -1);
    assert.strictEqual(U.compareVersions("2.10.0", "2.9.9"), 1);
    assert.strictEqual(U.shortVersion("3.0.0"), "3.0");
    assert.strictEqual(U.shortVersion("3.0.1"), "3.0.1");
  });

  test("atualização: só oferece Release mais novo, publicado e com o .exe", () => {
    const u = U.pickUpdate(rel("v3.0.0"), "2.9.0");
    assert(u && u.version === "3.0.0" && u.name === "Rhythm-3.0.exe" && u.notes === "notas");
    assert.strictEqual(U.pickUpdate(rel("v3.0.0"), "3.0.0"), null);
    assert.strictEqual(U.pickUpdate(rel("v2.9.1"), "3.0.0"), null);
    assert.strictEqual(U.pickUpdate(rel("v3.0.1", { prerelease: true }), "3.0.0"), null);
    assert.strictEqual(U.pickUpdate(rel("v3.0.1", { draft: true }), "3.0.0"), null);
    assert.strictEqual(U.pickUpdate(rel("v3.0.1", { assets: [{ name: "notas.txt", browser_download_url: "x" }] }), "3.0.0"), null);
    assert.strictEqual(U.pickUpdate(null, "3.0.0"), null);
  });

  test("atualização: consulta e baixa (com redirecionamento) de um servidor local", async () => {
    const http = require("http");
    const payload = Buffer.alloc(200000, 7);
    const srv = http.createServer((req, res) => {
      const port = srv.address().port;
      if (req.url === "/latest") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(rel("v3.0.1", { assets: [{ name: "Rhythm-3.0.1.exe", browser_download_url: `http://127.0.0.1:${port}/redir`, size: payload.length }] })));
      } else if (req.url === "/redir") { res.writeHead(302, { Location: "/file" }); res.end(); }
      else if (req.url === "/file") { res.setHeader("Content-Length", payload.length); res.end(payload); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    global.localStorage = { getItem: (k) => (k === "rhythm.updateUrl" ? `http://127.0.0.1:${port}/latest` : null) };
    try {
      const u = await U.check("3.0.0");
      assert(u && u.version === "3.0.1");
      let last = 0;
      const dest = await U.download(u, (f) => (last = f));
      assert.strictEqual(fs.statSync(dest).size, payload.length);
      assert(last > 0.99);
      assert.strictEqual(await U.check("3.0.1"), null);
      fs.rmSync(path.dirname(dest), { recursive: true, force: true });
    } finally {
      delete global.localStorage;
      srv.close();
    }
  });

  test("atualização: o botão aparece no painel (CSInterface real, como no CEP)", async () => {
    const http = require("http"), vm = require("vm");
    const extDir = path.join(__dirname, "..", "extension");
    const srv = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rel("v99.0.1")));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}/latest`;
    const win = {
      navigator: { userAgent: "Windows NT 10.0" },
      __adobe_cep__: { getSystemPath: () => "file:///" + encodeURI(extDir.split(path.sep).join("/")) },
      localStorage: { getItem: (k) => (k === "rhythm.updateUrl" ? url : null) },
    };
    win.window = win;
    const ctx = vm.createContext(Object.assign(win, { require, module: undefined, console, setTimeout, Buffer, URL, process }));
    // como no painel: scripts soltos no mesmo escopo global, sem SystemPath global
    vm.runInContext(fs.readFileSync(path.join(base, "lib", "CSInterface.js"), "utf8"), ctx);
    vm.runInContext(fs.readFileSync(path.join(base, "core", "updater.js"), "utf8"), ctx);
    const label = { textContent: "" };
    const btn = { hidden: true, title: "", classList: { toggle() {} }, querySelector: () => label, addEventListener() {} };
    try {
      ctx.AEUpdate.mount(btn, {});
      for (let i = 0; i < 50 && btn.hidden; i++) await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(btn.hidden, false, "o botão não apareceu");
      assert.strictEqual(label.textContent, "Atualizar para 99.0.1");
    } finally { srv.close(); }
  });
}

// ---------------------------------------------------------------- mídia real (opcional)
for (const f of (process.env.AE_REAL_MEDIA || "").split(";").filter(Boolean)) {
  test(`mídia real: ${path.basename(f)}`, async () => {
    const m = C.openMedia(f);
    assert(m.info.durationSec > 0);
    if (m.info.kind === "pcm") {
      const env = await L.mediaEnvelope(m, 0, Math.min(5, m.info.durationSec), null);
      assert(env.ms.length > 0);
    }
    m.src.close();
  });
}

// ---------------------------------------------------------------- runner
(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (e) {
      console.log(`FALHOU ${t.name}\n       ${e.message}`);
      process.exitCode = 1;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} testes passaram`);
})();
