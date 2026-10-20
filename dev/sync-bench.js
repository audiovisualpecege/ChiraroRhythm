/**
 * Banco de prova da aba Sincronizar contra um gabarito (sequência de entrada
 * + resultado de outro programa, ex.: Syncalia).
 *
 *   node dev/sync-bench.js extract <gabarito.json> <cacheDir>   lê o áudio de todos os arquivos (cache)
 *   node dev/sync-bench.js run     <gabarito.json> <cacheDir>   casa, monta a corrente e compara
 *
 * gabarito.json: { fps, tracks: [{ id, clips: [{ name, path, start, end, inPoint, outPoint, syncedStart }] }] }
 */
const fs = require("fs");
const path = require("path");
const A = require("../extension/js/sync/syncAudio.js");
const M = () => require("../extension/js/sync/syncMatch.js");
const P = () => require("../extension/js/sync/syncPlan.js");

const [cmd, gabFile, cacheDir] = process.argv.slice(2);
const gab = JSON.parse(fs.readFileSync(gabFile, "utf8"));
fs.mkdirSync(cacheDir, { recursive: true });

const keyOf = (p) => p.replace(/[^A-Za-z0-9]+/g, "_").slice(-120);

function saveFeat(file, f) {
  const head = Buffer.alloc(16);
  head.writeUInt32LE(f.env.length, 0);
  head.writeUInt32LE(f.lm.hash.length, 4);
  head.writeFloatLE(f.durationSec, 8);
  head.writeUInt32LE(f.wave.length, 12);
  const pad = Buffer.alloc((4 - (f.wave.length % 4)) % 4);
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(f.env.buffer, f.env.byteOffset, f.env.byteLength), Buffer.from(f.lm.hash.buffer), Buffer.from(f.lm.t.buffer), Buffer.from(f.wave.buffer, f.wave.byteOffset, f.wave.byteLength), pad]));
}
function loadFeat(file) {
  const b = fs.readFileSync(file);
  const ne = b.readUInt32LE(0), nl = b.readUInt32LE(4), nw = b.readUInt32LE(12);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  let o = 16;
  const env = new Float32Array(ab, o, ne); o += ne * 4;
  const hash = new Uint32Array(ab, o, nl); o += nl * 4;
  const t = new Uint32Array(ab, o, nl); o += nl * 4;
  const wave = new Int8Array(ab, o, nw);
  return { env, envMs: A.ENV_MS, hopSec: A.HOP_SEC, waveSr: A.WAVE_SR, wave, durationSec: b.readFloatLE(8), lm: { hash, t } };
}

async function extract() {
  const files = [...new Set(gab.tracks.flatMap((t) => t.clips.map((c) => c.path)))];
  const t0 = Date.now();
  let audioSec = 0;
  for (let i = 0; i < files.length; i++) {
    const out = path.join(cacheDir, keyOf(files[i]) + ".feat");
    if (fs.existsSync(out)) continue;
    const f = await A.analyzeFile(files[i]);
    audioSec += f.durationSec;
    saveFeat(out, f);
    if (i % 50 === 0) console.log(`${i + 1}/${files.length}  ${((Date.now() - t0) / 1000).toFixed(1)} s  áudio ${(audioSec / 3600).toFixed(2)} h`);
  }
  console.log(`extração: ${((Date.now() - t0) / 1000).toFixed(1)} s para ${(audioSec / 3600).toFixed(2)} h de áudio`);
}

function buildInput() {
  // um item por clipe; cada faixa é um aparelho; relógio do arquivo (corrigido depois pelo plano)
  const K = require("../extension/js/sync/syncClock.js");
  const clocks = new Map();
  const clockOf = (p) => { if (!clocks.has(p)) { const r = K.recordedAt(p); clocks.set(p, r ? r.t : null); } return clocks.get(p); };
  const items = [];
  gab.tracks.forEach((t, ti) => t.clips.forEach((c, k) => items.push({
    id: items.length, track: ti, trackId: t.id, index: k, name: c.name, path: c.path,
    start: c.start, end: c.end, inPoint: c.inPoint, outPoint: c.outPoint, syncedStart: c.syncedStart,
    clock: process.env.NOCLOCK ? null : clockOf(c.path),
  })));
  return items;
}

/** Espaçamento: vão entre clipes seguidos da mesma câmera, nós × Syncalia, por faixa de pausa real. */
function spacing(items, placed) {
  const rows = [];
  const byT = new Map();
  items.forEach((it, i) => { if (!byT.has(it.track)) byT.set(it.track, []); byT.get(it.track).push(i); });
  for (const list of byT.values()) {
    for (let k = 1; k < list.length; k++) {
      const a = items[list[k - 1]], b = items[list[k]];
      if (a.clock == null || b.clock == null) continue;
      const real = b.clock + b.inPoint - (a.clock + a.inPoint + (a.end - a.start));
      if (real < -5 || real > 6 * 3600) continue;
      const ours = placed[list[k]].start - (placed[list[k - 1]].start + (a.end - a.start));
      const syn = b.syncedStart - (a.syncedStart + (a.end - a.start));
      rows.push({ real, ours, syn });
    }
  }
  const bins = [[0, 30], [30, 120], [120, 600], [600, 1800], [1800, 1e9]];
  const med = (x) => { const s = x.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  console.log("espaçamento (vão entre arquivos seguidos da mesma câmera, mediana):");
  for (const [lo, hi] of bins) {
    const r = rows.filter((x) => x.real >= lo && x.real < hi);
    if (!r.length) continue;
    console.log(`  pausa real ${lo}–${hi > 1e8 ? "∞" : hi} s (n=${r.length}): Syncalia ${med(r.map((x) => x.syn)).toFixed(1)} s · nós ${med(r.map((x) => x.ours)).toFixed(1)} s`);
  }
}

/** Votos das impressões digitais no deslocamento D (s) entre duas mídias. */
function votesAt(fa, fb, D) {
  const idx = new Map();
  for (let i = 0; i < fb.lm.hash.length; i++) {
    const h = fb.lm.hash[i];
    if (!idx.has(h)) idx.set(h, []);
    idx.get(h).push(fb.lm.t[i]);
  }
  const off = Math.round(D / fa.hopSec);
  let c = 0;
  for (let i = 0; i < fa.lm.hash.length; i++) {
    const l = idx.get(fa.lm.hash[i]);
    if (l) for (const tb of l) if (Math.abs(fa.lm.t[i] - tb - off) <= 1) c++;
  }
  return c;
}

function compare(items, placed, fps, feats) {
  const frame = 1 / fps;
  // pares que se sobrepõem no gabarito (> 1 s) em faixas diferentes E que o
  // áudio confirma (≥ 6 votos no deslocamento do gabarito); sobreposições sem
  // evidência são órfãos do outro programa encostados por acaso
  const gs = items.map((it) => ({ st: it.syncedStart, en: it.syncedStart + (it.end - it.start) }));
  let pairs = 0, agree = 0, agree3 = 0, unconfirmed = 0;
  const confirmed = [];
  const clipOk = new Map();
  const bad = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (items[i].track === items[j].track) continue;
    const ov = Math.min(gs[i].en, gs[j].en) - Math.max(gs[i].st, gs[j].st);
    if (ov < 1) continue;
    const D = (gs[j].st - items[j].inPoint) - (gs[i].st - items[i].inPoint);
    if (votesAt(feats.get(items[i].path), feats.get(items[j].path), D) < 6) { unconfirmed++; continue; }
    pairs++;
    confirmed.push({ i, j, D });
    const dg = gs[j].st - gs[i].st;
    const pi = placed[i], pj = placed[j];
    const same = pi.synced && pj.synced && pi.group === pj.group;
    const err = same ? Math.abs(pj.start - pi.start - dg) : Infinity;
    const ok = err <= frame + 0.002;
    if (err <= 3 * frame + 0.002) agree3++;
    if (ok) agree++;
    else if (bad.length < 4000) bad.push({ a: i, b: j, dg, ours: pi.group === pj.group ? pj.start - pi.start : null });
    void ok;
    for (const x of [i, j]) {
      const s = clipOk.get(x) || { ok: 0, n: 0 };
      s.n++; if (ok) s.ok++;
      clipOk.set(x, s);
    }
  }
  const clipsWithPartner = clipOk.size;
  const clipsAllOk = [...clipOk.values()].filter((s) => s.ok === s.n).length;
  const clipsAnyOk = [...clipOk.values()].filter((s) => s.ok > 0).length;
  return { pairs, agree, agree3, unconfirmed, clipsWithPartner, clipsAllOk, clipsAnyOk, bad, confirmed };
}

async function run() {
  const items = buildInput();
  const feats = new Map();
  for (const it of items) {
    if (!feats.has(it.path)) feats.set(it.path, loadFeat(path.join(cacheDir, keyOf(it.path) + ".feat")));
  }
  const t0 = Date.now();
  const debug = {};
  const fm = await M().findMatches(items.map((it) => ({ id: it.id, track: it.track, media: it.path })), feats, { log: console.log, debug });
  const matches = fm.matches;
  const t1 = Date.now();
  const plan = await P().buildPlan(items, fm, {
    fps: gab.fps, log: console.log,
    joinGapSec: process.env.JOIN ? +process.env.JOIN : undefined,
    gapRatio: process.env.RATIO ? +process.env.RATIO : undefined,
    orphanWeight: process.env.OW ? +process.env.OW : undefined, debugSpans: process.env.SPANS ? (s) => console.table(s) : null, debugPush: process.env.PUSH ? (x) => console.log("PUSH", JSON.stringify(x)) : null });
  const t2 = Date.now();
  console.log(`casamento ${((t1 - t0) / 1000).toFixed(1)} s · plano (com verificação dos pendentes) ${((t2 - t1) / 1000).toFixed(1)} s · total ${((t2 - t0) / 1000).toFixed(1)} s · grupos ${plan.groups.length} · órfãos ${plan.orphans}`);
  console.log(`conflitos: ${plan.conflicts.length} (ordem ${plan.conflicts.filter((c) => c.order).length}) · grupos desfeitos: ${plan.dissolved.length} (${plan.dissolved.reduce((n, d) => n + d.members.length, 0)} fontes) · ok=${plan.ok} · sem espaço: ${plan.warnings.length} · deriva>1q: ${plan.drift.length}`);
  spacing(items, plan.placed);
  {
    const endOf = (arr, st) => Math.max(...arr.map((it, i) => st(i) + it.end - it.start));
    console.log(`duração: Geral ${(endOf(items, (i) => items[i].start) / 3600).toFixed(2)} h · Syncalia ${(endOf(items, (i) => items[i].syncedStart) / 3600).toFixed(2)} h · nós ${(endOf(items, (i) => plan.placed[i].start) / 3600).toFixed(2)} h`);
  }
  const r = compare(items, plan.placed, gab.fps, feats);
  console.log(`pares do gabarito confirmados pelo áudio: ${r.pairs} (sobreposições sem evidência ignoradas: ${r.unconfirmed}) · iguais até 1 quadro: ${r.agree} (${((100 * r.agree) / r.pairs).toFixed(1)}%) · até 3 quadros: ${r.agree3} (${((100 * r.agree3) / r.pairs).toFixed(1)}%)`);
  console.log(`clipes com parceiro no gabarito: ${r.clipsWithPartner} · todos os pares batem: ${r.clipsAllOk} (${((100 * r.clipsAllOk) / r.clipsWithPartner).toFixed(1)}%) · ao menos um par bate: ${r.clipsAnyOk} (${((100 * r.clipsAnyOk) / r.clipsWithPartner).toFixed(1)}%)`);
  if (process.env.TRACE) {
    const [x, y] = process.env.TRACE.split("~");
    const hits = fm.pending.filter((p) => (p.a.media + p.b.media).toUpperCase().includes(x.toUpperCase()));
    console.log("TRACE pendentes com", x, ":", hits.length, hits.slice(0, 8).map((p) => path.basename(p.a.media) + "~" + path.basename(p.b.media) + "(" + p.votes + "," + p.second + "," + p._why + ")").join(" "));
    const sh = fm.matches.filter((p) => (p.a.media + p.b.media).toUpperCase().includes(x.toUpperCase()));
    console.log("TRACE fortes com", x, ":", sh.map((p) => path.basename(p.a.media) + "~" + path.basename(p.b.media) + "(" + p.votes + ")").join(" "));
    for (const p of fm.pending) {
      const na = path.basename(p.a.media), nb = path.basename(p.b.media);
      if ((na.toUpperCase() === x.toUpperCase() && nb.toUpperCase() === y.toUpperCase()) || (na.toUpperCase() === y.toUpperCase() && nb.toUpperCase() === x.toUpperCase())) {
        console.log("TRACE", na, nb, "votos", p.votes, "seg", p.second, "ratio", p.ratio, "offsets", JSON.stringify(p.offsets), "por quê:", p._why, "status", p._c && p._c.status);
        const fa = feats.get(p.a.media), fb = feats.get(p.b.media);
        for (const o of p.offsets) {
          const g1 = M().gccRefine(fa, fb, o.off, Object.assign({}, M().DEFAULTS, { gccMinSharp: 0 }), 1);
          const g3 = M().gccRefine(fa, fb, o.off, Object.assign({}, M().DEFAULTS, { gccMinSharp: 0 }), 3);
          console.log("TRACE   off", o.off.toFixed(3), "gcc1", g1 && g1.sharp.toFixed(1), g1 && g1.offset.toFixed(3), "gcc3", g3 && g3.sharp.toFixed(1), g3 && g3.offset.toFixed(3));
        }
        console.log("TRACE   verify ->", JSON.stringify(fm.verify(p)));
      }
    }
  }
  if (process.env.GROUPS) {
    const nm = (id) => { const s = plan.sources[id]; return items.find((it) => it.track === s.track && it.path === s.path).trackId + ":" + s.clips.map((c) => c.name).join("+"); };
    const byG = new Map();
    plan.placed.forEach((p, i) => { if (p.synced) { if (!byG.has(p.group)) byG.set(p.group, []); byG.get(p.group).push(items[i]); } });
    for (const [g, arr] of byG) {
      const per = {};
      for (const it of arr) per[it.trackId] = (per[it.trackId] || 0) + 1;
      const s = arr.map((it) => plan.placed[it.id].start);
      console.log(`grupo ${g}: ${arr.length} clipes ${JSON.stringify(per)} · ${Math.min(...s).toFixed(0)}–${Math.max(...s).toFixed(0)} s · ex: ${arr.slice(0, 4).map((it) => it.trackId + ":" + it.name).join(", ")}`);
    }
    for (const d of plan.dissolved.slice(0, 12)) console.log(`desfeito: [${d.members.map(nm).join(" | ")}]  ciclo com: ${d.cycle.filter((c) => c.root !== d.root).map((c) => "[" + c.members.slice(0, 3).map(nm).join(" | ") + (c.members.length > 3 ? " …+" + (c.members.length - 3) : "") + "]").join(" ")}`);
  }
  // onde cada par confirmado se perdeu
  const cand = new Map();
  for (const c of debug.candidates) cand.set(c.aId < c.bId ? c.aId + "#" + c.bId : c.bId + "#" + c.aId, c);
  for (const p of fm.pending) if (p._c) p._c._why = p._why;
  const fate = {};
  const lost = [];
  for (const p of r.confirmed) {
    const A = items[p.i], B = items[p.j];
    const ka = A.track + "|" + A.path, kb = B.track + "|" + B.path;
    const c = cand.get(ka < kb ? ka + "#" + kb : kb + "#" + ka);
    const pi = plan.placed[p.i], pj = plan.placed[p.j];
    let f;
    const dPos = Math.abs(pj.start - pi.start - (items[p.j].syncedStart - items[p.i].syncedStart));
    if (pi.synced && pj.synced && pi.group === pj.group) {
      f = dPos <= 1 / gab.fps + 0.002 ? "bate" : dPos <= 3 / gab.fps + 0.002 ? "mesmo grupo, difere 2–3 quadros" : "mesmo grupo, difere > 3 quadros";
    } else if (!c) f = "sem candidato (votos < mínimo)";
    else if (pi.synced && pj.synced) f = "ambos sincronizados, grupos diferentes";
    else f = "fora de grupo: " + c.status + (c._why ? "/" + c._why : "");
    fate[f] = (fate[f] || 0) + 1;
    if (f.startsWith("fora") && process.env.LOST === "refine" && lost.length < 30) {
      const fa = feats.get(A.path), fb = feats.get(B.path);
      const o1 = M().gccRefine(fa, fb, c.coarse, Object.assign({}, M().DEFAULTS, { gccMinSharp: 0 }), 1);
      const o3 = M().gccRefine(fa, fb, p.D, Object.assign({}, M().DEFAULTS, { gccMinSharp: 0 }), 3);
      const ov = Math.min(A.syncedStart + A.end - A.start, B.syncedStart + B.end - B.start) - Math.max(A.syncedStart, B.syncedStart);
      lost.push({ par: `${A.trackId}:${A.name}~${B.trackId}:${B.name}`, f, votos: c.votes, seg: c.second, sobrep: ov.toFixed(1), sharp1: o1 ? o1.sharp.toFixed(1) : "-", sharp3noD: o3 ? o3.sharp.toFixed(1) : "-", difCoarseMs: ((c.coarse - p.D) * 1000).toFixed(0) });
      continue;
    }
    if (f !== "bate" && process.env.LOST !== "refine" && lost.length < 30) lost.push({ par: `${A.trackId}:${A.name}~${B.trackId}:${B.name}`, f, votos: c && c.votes, seg: c && c.second, D: p.D.toFixed(2), coarse: c && c.coarse.toFixed(2), dif: f === "mesmo grupo, posição difere" ? ((pj.start - pi.start - (items[p.j].syncedStart - items[p.i].syncedStart)) * 1000).toFixed(0) + "ms" : "" });
  }
  console.log("destino dos pares confirmados:", fate);
  {
    // qualidade de cada regra de aceite fraco: o par aceito bate com o Syncalia (±3 q)?
    const fr = 1 / gab.fps;
    const firstClip = new Map();
    items.forEach((it, i) => { const k = it.track + "|" + it.path; if (!firstClip.has(k)) firstClip.set(k, i); });
    const stat = {};
    for (const p of fm.pending) {
      if (p._why !== "verificado" || !p._m) continue;
      const zb = p._m.sharp < 4.5 ? "4.0–4.5" : p._m.sharp < 5 ? "4.5–5.0" : "5.0+";
      const kind = !p._m.review ? "forte (z≥limiar)" : p._m.precise ? `revisar: GCC z ${zb}, razão ${p.ratio >= 2 ? "≥2" : "<2"}` : "revisar: só impressões";
      const i = firstClip.get(p.a.track + "|" + p.a.media), j = firstClip.get(p.b.track + "|" + p.b.media);
      const A = items[i], B = items[j];
      const Dg = (B.syncedStart - B.inPoint) - (A.syncedStart - A.inPoint);
      const gov = Math.min(A.syncedStart + A.end - A.start, B.syncedStart + B.end - B.start) - Math.max(A.syncedStart, B.syncedStart);
      const s = stat[kind] || (stat[kind] = { n: 0, igualSyncalia: 0, syncaliaNaoJuntou: 0, outraPosicao: 0 });
      s.n++;
      if (gov < 0.5) s.syncaliaNaoJuntou++;
      else if (Math.abs(p._m.offset - Dg) <= 3 * fr + 0.002) s.igualSyncalia++;
      else s.outraPosicao++;
    }
    console.table(stat);
  }
  {
    // o que juntamos e o Syncalia não: real (GCC confirma no NOSSO deslocamento) ou falso positivo?
    const fr = 1 / gab.fps;
    let extra = 0, extraZ = 0, extraWeak = 0;
    const syncedClips = new Set();
    for (let i = 0; i < items.length; i++) {
      const pi = plan.placed[i];
      if (!pi.synced) continue;
      syncedClips.add(i);
      for (let j = i + 1; j < items.length; j++) {
        const pj = plan.placed[j];
        if (!pj.synced || pj.group !== pi.group || items[i].track === items[j].track) continue;
        const ov = Math.min(pi.start + items[i].end - items[i].start, pj.start + items[j].end - items[j].start) - Math.max(pi.start, pj.start);
        if (ov < 1) continue;
        const gsd = items[j].syncedStart - items[i].syncedStart;
        if (Math.abs(pj.start - pi.start - gsd) <= 3 * fr + 0.002) continue; // Syncalia também tem (±3 quadros)
        extra++;
        const Do = (pj.start - items[j].inPoint) - (pi.start - items[i].inPoint);
        const g = M().gccRefine(feats.get(items[i].path), feats.get(items[j].path), Do, Object.assign({}, M().DEFAULTS, { gccMinSharp: -1e9 }));
        if (g && g.sharp >= 5) extraZ++;
        else extraWeak++;
      }
    }
    const synSyn = new Set();
    for (const p of r.confirmed) { synSyn.add(p.i); synSyn.add(p.j); }
    console.log(`clipes sincronizados — nós: ${syncedClips.size} · Syncalia (com par confirmado pelo áudio): ${synSyn.size} · em ambos: ${[...syncedClips].filter((x) => synSyn.has(x)).length}`);
    console.log(`pares que só nós juntamos (ou em outra posição): ${extra} · confirmados pela forma de onda (z≥5): ${extraZ} · sem confirmação: ${extraWeak}`);
  }
  if (process.env.OUTSIDE) {
    // evidência dos pares reais que ficaram fora (para calibrar o aceite por contexto)
    const rows = [];
    for (const p of r.confirmed) {
      const A = items[p.i], B = items[p.j];
      const pi = plan.placed[p.i], pj = plan.placed[p.j];
      if (pi.synced && pj.synced && pi.group === pj.group) continue;
      const ka = A.track + "|" + A.path, kb = B.track + "|" + B.path;
      const c = cand.get(ka < kb ? ka + "#" + kb : kb + "#" + ka);
      if (!c) continue;
      const g = M().gccRefine(feats.get(A.path), feats.get(B.path), p.D, Object.assign({}, M().DEFAULTS, { gccMinSharp: -1e9 }));
      const ov = Math.min(A.syncedStart + A.end - A.start, B.syncedStart + B.end - B.start) - Math.max(A.syncedStart, B.syncedStart);
      const topOk = Math.abs(c.coarse - p.D) < 0.1;
      rows.push({ votos: c.votes, razao: c.second ? +(c.votes / c.second).toFixed(1) : 99, z: g ? +g.sharp.toFixed(1) : 0, sobrep: +ov.toFixed(1), melhorEhOCerto: topOk });
    }
    const n = rows.length;
    const pct = (f) => ((100 * rows.filter(f).length) / n).toFixed(0) + "%";
    console.log(`fora de grupo com candidato: ${n} · melhor deslocamento = o do gabarito: ${pct((x) => x.melhorEhOCerto)} · votos≥10: ${pct((x) => x.votos >= 10)} · razão≥2: ${pct((x) => x.razao >= 2)} · z≥4: ${pct((x) => x.z >= 4)} · z≥4.5: ${pct((x) => x.z >= 4.5)} · sobreposição<10s: ${pct((x) => x.sobrep < 10)}`);
    console.table(rows.slice(0, 15));
  }

  // árbitro independente: atraso medido direto na forma de onda (GCC-PHAT)
  // em cada par confirmado; quem fica mais perto dele, Syncalia ou nós?
  const fr = 1 / gab.fps;
  const arb = { medidos: 0, syncalia1q: 0, syncalia3q: 0, nos1q: 0, nos3q: 0, nosAusente: 0 };
  const opt = Object.assign({}, M().DEFAULTS);
  for (const p of r.confirmed) {
    const A = items[p.i], B = items[p.j];
    const g = M().gccRefine(feats.get(A.path), feats.get(B.path), p.D, opt);
    if (!g || !g.ok) continue;
    arb.medidos++;
    const eS = Math.abs(p.D - g.offset);
    if (eS <= fr / 2 + 0.002) arb.syncalia1q++;
    if (eS <= 1.5 * fr + 0.002) arb.syncalia3q++;
    const pi = plan.placed[p.i], pj = plan.placed[p.j];
    if (!(pi.synced && pj.synced && pi.group === pj.group)) { arb.nosAusente++; continue; }
    const Do = (pj.start - B.inPoint) - (pi.start - A.inPoint);
    const eO = Math.abs(Do - g.offset);
    if (eO <= fr / 2 + 0.002) arb.nos1q++;
    if (eO <= 1.5 * fr + 0.002) arb.nos3q++;
  }
  const pc = (x) => ((100 * x) / arb.medidos).toFixed(1) + "%";
  {
    const synSyn = new Set();
    for (const p of r.confirmed) { synSyn.add(p.i); synSyn.add(p.j); }
    const both = [...synSyn].filter((x) => plan.placed[x].synced).length;
    const cov = (100 * both) / synSyn.size;
    console.log(`META 1 — cobertura: ${both}/${synSyn.size} = ${cov.toFixed(1)}% (alvo ≥ 90%) ${cov >= 90 ? "OK" : "ABAIXO"}`);
    const ok2 = arb.nos1q >= arb.syncalia1q && arb.nos3q >= arb.syncalia3q;
    console.log(`META 2 — precisão vs forma de onda: quadro exato nós ${pc(arb.nos1q)} × Syncalia ${pc(arb.syncalia1q)} · ±1 quadro nós ${pc(arb.nos3q)} × Syncalia ${pc(arb.syncalia3q)} ${ok2 ? "OK" : "ABAIXO"}`);
  }
  console.log(`árbitro GCC-PHAT (${arb.medidos} pares medidos): no quadro mais próximo do atraso medido — Syncalia ${pc(arb.syncalia1q)} · nós ${pc(arb.nos1q)} | até ±1 quadro — Syncalia ${pc(arb.syncalia3q)} · nós ${pc(arb.nos3q)} | pares que nós não juntamos: ${arb.nosAusente}`);
  if (process.env.LOST) console.table(lost);
  fs.writeFileSync(path.join(cacheDir, "result.json"), JSON.stringify({ items, placed: plan.placed, groups: plan.groups, bad: r.bad, matches }, null, 0));
}

(cmd === "extract" ? extract() : run()).catch((e) => { console.error(e); process.exit(1); });
