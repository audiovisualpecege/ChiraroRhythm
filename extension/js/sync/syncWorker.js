/**
 * syncWorker.js — roda num worker_threads (Node), usado pelo syncPool.
 * Tarefas:
 *  - analyze { path }   → lê o áudio do arquivo + hora de gravação
 *  - gcc { jobs }       → janelas de GCC-PHAT (a parte pesada da precisão)
 */
const { parentPort } = require("worker_threads");
const path = require("path");
const A = require(path.join(__dirname, "syncAudio.js"));
const M = require(path.join(__dirname, "syncMatch.js"));
const K = require(path.join(__dirname, "syncClock.js"));

let index = null; // índice de impressões da análise atual (para a votação)

/** Copia para um buffer próprio (subarray não pode ser transferido sozinho). */
const own = (ta) => (ta.byteOffset === 0 && ta.byteLength === ta.buffer.byteLength ? ta : ta.slice());

parentPort.on("message", async (msg) => {
  const { id, type } = msg;
  try {
    if (type === "analyze") {
      const f = await A.analyzeFile(msg.path);
      const rec = K.recordedAt(msg.path);
      const env = own(f.env), wave = own(f.wave), hash = own(f.lm.hash), t = own(f.lm.t);
      parentPort.postMessage(
        { id, ok: true, feat: { durationSec: f.durationSec, envMs: f.envMs, waveSr: f.waveSr, hopSec: f.hopSec, peakCount: f.peakCount, clock: rec ? rec.t : null, env, wave, lm: { hash, t } } },
        [env.buffer, wave.buffer, hash.buffer, t.buffer]
      );
    } else if (type === "setIndex") {
      index = msg.index;
      parentPort.postMessage({ id, ok: true });
    } else if (type === "vote") {
      if (!index) throw new Error("índice não recebido");
      const r = M.voteRange(index, msg.from, msg.to, msg.params);
      parentPort.postMessage({ id, ok: true, result: r });
    } else if (type === "gcc") {
      const out = msg.jobs.map(M.gccCompute);
      const transfer = out.filter(Boolean).map((r) => r.r.buffer);
      parentPort.postMessage({ id, ok: true, results: out }, transfer);
    } else {
      throw new Error("tarefa desconhecida: " + type);
    }
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message, needsMain: /decodificador/.test(err.message) });
  }
});
