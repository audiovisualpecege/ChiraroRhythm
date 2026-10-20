/**
 * Teste ao vivo da aba Sincronizar sem o painel: usa a resposta real de
 * host syncInfo e a MESMA lógica do painel (syncSetup + motor).
 *
 *   node dev/sync-live.js plan  <syncinfo.json> <cacheDir> <saida-moves.json>
 *      lê o áudio (reaproveita o cache do banco de prova), casa, monta o plano
 *      e grava os movimentos em ordem segura (para api.syncMove)
 *   node dev/sync-live.js check <syncinfo.json> <plano.json> <posicoes-reais.json>
 *      confere as posições lidas da cópia no Premiere contra o plano
 */
const fs = require("fs");
const path = require("path");
const A = require("../extension/js/sync/syncAudio.js");
const M = require("../extension/js/sync/syncMatch.js");
const P = require("../extension/js/sync/syncPlan.js");
const S = require("../extension/js/sync/syncSetup.js");

const TPS = 254016000000;
const [cmd, siFile, b, c] = process.argv.slice(2);
const readJson = (f) => {
  let raw = fs.readFileSync(f, "utf8").replace(/^﻿/, "");
  const o = JSON.parse(raw);
  return o.ok !== undefined ? o.data : o;
};
const si = readJson(siFile);
const keyOf = (p) => p.replace(/[^A-Za-z0-9]+/g, "_").slice(-120);

function loadFeat(file) {
  const buf = fs.readFileSync(file);
  const ne = buf.readUInt32LE(0), nl = buf.readUInt32LE(4), nw = buf.readUInt32LE(12);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  let o = 16;
  const env = new Float32Array(ab, o, ne); o += ne * 4;
  const hash = new Uint32Array(ab, o, nl); o += nl * 4;
  const t = new Uint32Array(ab, o, nl); o += nl * 4;
  return { env, envMs: A.ENV_MS, hopSec: A.HOP_SEC, waveSr: A.WAVE_SR, wave: new Int8Array(ab, o, nw), durationSec: buf.readFloatLE(8), lm: { hash, t } };
}

async function plan(cacheDir, outFile) {
  const t0 = Date.now();
  const devices = S.buildDevices(si);
  console.log("aparelhos:", devices.map((d) => `${d.label} (${d.clips.length}${d.locked ? ", travado" : ""})`).join(" · "));
  const items = S.buildItems(devices, new Set(), (p) => path.normalize(p));
  const feats = new Map();
  let fresh = 0;
  const PC = require("../extension/js/sync/syncCache.js");
  for (const it of items) {
    if (it.noAudio || feats.has(it.path)) continue;
    // 1º o cache do painel (%APPDATA%\AutomacaoEdicao\cache, .rfeat); depois o antigo do banco (.feat)
    const pc = PC.load(cacheDir, it.path);
    if (pc) { feats.set(it.path, pc); continue; }
    const cf = path.join(cacheDir, keyOf(it.path) + ".feat");
    if (fs.existsSync(cf)) feats.set(it.path, loadFeat(cf));
    else { const f = await A.analyzeFile(it.path); feats.set(it.path, f); PC.save(cacheDir, it.path, f); fresh++; }
  }
  console.log(`itens: ${items.length} · sem áudio: ${items.filter((i) => i.noAudio).length} · áudios: ${feats.size} (lidos agora: ${fresh})`);
  const K = require("../extension/js/sync/syncClock.js");
  const clocks = new Map();
  for (const it of items) {
    const p = it.mediaPath;
    if (!clocks.has(p)) { const r = K.recordedAt(p); clocks.set(p, r ? r.t : null); }
    it.clock = clocks.get(p);
  }
  const clips = items.filter((it) => !it.noAudio).map((it) => ({ id: it.id, track: it.track, media: it.path }));
  const fm = await M.findMatches(clips, feats, {});
  const fps = TPS / si.timebase;
  // mesmas opções do painel (syncTool.replan, prefs padrão)
  const pl = await P.buildPlan(items, fm, { fps, log: console.log, joinGapSec: 30, gapRatio: 0.15, maxGapSec: 600 });
  const synced = pl.placed.filter((p) => p.synced);
  console.log(`grupos ${pl.groups.length} · sincronizados ${synced.length} (revisar ${synced.filter((p) => p.review).length}) · órfãos ${pl.orphans} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const moves = S.buildMoves(items, pl.placed, si);
  // simulação: aplica a lista em memória a partir do estado original, passo a passo
  {
    const tracks = new Map(); // "v|t" -> [{ s, e }]
    si.video.forEach((tr) => tracks.set("1|" + tr.index, tr.clips.map((c) => ({ s: c.start, e: c.end }))));
    si.audio.forEach((tr) => tracks.set("0|" + tr.index, tr.clips.map((c) => ({ s: c.start, e: c.end }))));
    const tb = si.timebase;
    let overlaps = 0, maxApart = 0;
    let pendingAudio = 0;
    const linkedOf = new Map();
    items.forEach((it) => { if (it.phys.v) linkedOf.set("1|" + it.phys.t + "|" + it.phys.i, it.phys.audio.length); });
    for (const m of moves) {
      const arr = tracks.get(m.v + "|" + m.t);
      const c = arr[m.i];
      const len = c.e - c.s;
      c.s = m.to; c.e = m.to + len;
      for (let j = 0; j < arr.length; j++) if (j !== m.i && arr[j].s < c.e - tb / 2 && arr[j].e > c.s + tb / 2) overlaps++;
      if (m.v) pendingAudio = linkedOf.get("1|" + m.t + "|" + m.i) || 0;
      else if (pendingAudio > 0) pendingAudio--;
      maxApart = Math.max(maxApart, m.v ? 0 : 0);
    }
    console.log(`simulação: ${moves.length} passos · sobreposições durante o caminho: ${overlaps} · ordem clipe a clipe (vídeo → seu áudio): ${moves.length > 1 && moves[0].v === 1 && moves[1].v === 0 ? "sim" : "não"}`);
  }
  fs.writeFileSync(outFile, JSON.stringify(moves));
  fs.writeFileSync(outFile.replace(/\.json$/, "-plano.json"), JSON.stringify({ items: items.map((it) => ({ id: it.id, name: it.name, phys: it.phys })), placed: pl.placed }));
  console.log(`movimentos: ${moves.length} → ${outFile}`);
}

function check(planFile, realFile) {
  const pl = readJson(planFile);
  const real = readJson(realFile); // { video: [[start ticks...]...], audio: [[...]] }
  const fps = TPS / si.timebase;
  let ok = 0, bad = 0, audioOk = 0, audioBad = 0;
  const ex = [];
  pl.items.forEach((it, n) => {
    const want = Math.round(pl.placed[n].start * fps) * si.timebase;
    const got = it.phys.v ? real.video[it.phys.t][it.phys.i] : real.audio[it.phys.t][it.phys.i];
    if (Math.abs(got - want) < si.timebase / 2) ok++;
    else { bad++; if (ex.length < 8) ex.push(`${it.name}: esperado ${(want / TPS).toFixed(3)} s, está em ${(got / TPS).toFixed(3)} s`); }
    for (const [t, i] of it.phys.audio) {
      if (Math.abs(real.audio[t][i] - want) < si.timebase / 2) audioOk++;
      else audioBad++;
    }
  });
  console.log(`clipes no lugar planejado: ${ok}/${ok + bad} · áudios vinculados junto do vídeo: ${audioOk}/${audioOk + audioBad}`);
  if (ex.length) console.log(ex.join("\n"));
}

(cmd === "plan" ? plan(b, c) : Promise.resolve(check(b, c))).catch((e) => { console.error(e); process.exit(1); });
