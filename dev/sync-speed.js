/**
 * Mede a velocidade da Sincronizar no gabarito, com os workers e o cache:
 *   node dev/sync-speed.js <gabarito.json> <pastaCache>
 * 1ª análise (sem cache, leitura em paralelo) e 2ª análise (com cache).
 */
const fs = require("fs");
const path = require("path");
const A = require("../extension/js/sync/syncAudio.js");
const M = require("../extension/js/sync/syncMatch.js");
const P = require("../extension/js/sync/syncPlan.js");
const C = require("../extension/js/sync/syncCache.js");
const K = require("../extension/js/sync/syncClock.js");
const Pool = require("../extension/js/sync/syncPool.js");

const [gabFile, cacheDir] = process.argv.slice(2);
const gab = JSON.parse(fs.readFileSync(gabFile, "utf8"));
const items = [];
gab.tracks.forEach((t, ti) => t.clips.forEach((c, k) => items.push({ id: items.length, track: ti, index: k, name: c.name, path: c.path, start: c.start, end: c.end, inPoint: c.inPoint })));
const files = [...new Set(items.map((i) => i.path))];

async function analysis(label, pool) {
  const t0 = Date.now();
  const feats = new Map();
  let fromCache = 0;
  await Promise.all(files.map(async (p) => {
    let f = C.load(cacheDir, p);
    if (f) { fromCache++; feats.set(p, f); return; }
    f = pool ? await pool.analyze(p) : null;
    if (!f) { f = await A.analyzeFile(p); const r = K.recordedAt(p); f.clock = r ? r.t : null; }
    feats.set(p, f);
    C.save(cacheDir, p, f);
  }));
  const t1 = Date.now();
  for (const it of items) it.clock = feats.get(it.path).clock;
  const fm = await M.findMatches(items.map((it) => ({ id: it.id, track: it.track, media: it.path })), feats, { runner: pool && pool.runner, voter: pool && pool.voter });
  const t2 = Date.now();
  const plan = await P.buildPlan(items, fm, { fps: gab.fps });
  const t3 = Date.now();
  console.log(`${label}: leitura ${((t1 - t0) / 1000).toFixed(1)} s (cache: ${fromCache}/${files.length}) · comparação ${((t2 - t1) / 1000).toFixed(1)} s · corrente ${((t3 - t2) / 1000).toFixed(1)} s · TOTAL ${((t3 - t0) / 1000).toFixed(1)} s · sincronizados ${plan.placed.filter((x) => x.synced).length}`);
}

(async () => {
  const pool = Pool.create({ workerFile: path.join(__dirname, "..", "extension", "js", "sync", "syncWorker.js"), max: Number(process.env.WORKERS || 8) });
  console.log(`workers: ${pool.parallel ? pool.size : "nenhum (sequencial)"}`);
  if (process.env.CLEAR) console.log("cache limpo:", C.clear(cacheDir), "arquivos");
  await analysis("1ª análise", pool);
  await analysis("2ª análise", pool);
  console.log(`cache em disco: ${(C.sizeOf(cacheDir) / 1048576).toFixed(0)} MB`);
  pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
