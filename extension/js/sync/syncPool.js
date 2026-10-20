/**
 * syncPool.js — vários núcleos para a Sincronizar (worker_threads do Node).
 *
 *  - analyze(path): lê o áudio de um arquivo num worker livre
 *  - runner(jobs):  executor de janelas de GCC (syncMatch.gccMany), dividido
 *                   entre os workers
 *
 * Se o worker_threads não existir (ou falhar ao criar), cai para o modo
 * sequencial na própria thread — o resultado é o mesmo, só mais lento.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncPool = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  /**
   * O Chromium 99 do CEP 12 (Premiere 26) desliga o SharedArrayBuffer global, e o
   * Node 17 dele precisa desse construtor para criar qualquer worker ("SharedArrayBuffer
   * is not a constructor" — foi por isso que a 2.4.0 rodou sem workers no painel).
   * A memória compartilhada do WebAssembly ainda entrega o construtor (medido 07/10).
   */
  function ensureSharedArrayBuffer() {
    if (typeof SharedArrayBuffer !== "undefined") return;
    try {
      const SAB = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer.constructor;
      if (SAB && SAB.name === "SharedArrayBuffer") globalThis.SharedArrayBuffer = SAB;
    } catch (e) { /* sem memória compartilhada: os workers vão falhar e cair no sequencial */ }
  }

  function create(opts) {
    opts = opts || {};
    let WorkerCtor = null;
    let reason = null;
    ensureSharedArrayBuffer();
    try { WorkerCtor = require("worker_threads").Worker; } catch (e) { WorkerCtor = null; reason = "worker_threads ausente: " + e.message; }
    const os = require("os");
    const size = Math.max(1, Math.min(opts.max || 8, (os.cpus() || []).length - 2 || 1));
    const workers = [];
    if (!opts.workerFile) reason = reason || "arquivo do worker não encontrado";
    if (WorkerCtor && opts.workerFile) {
      try {
        for (let i = 0; i < size; i++) workers.push({ w: new WorkerCtor(opts.workerFile), busy: false });
      } catch (e) {
        workers.forEach((x) => x.w.terminate());
        workers.length = 0;
        reason = e.message;
        if (opts.log) opts.log("workers indisponíveis: " + e.message);
      }
    }
    let seq = 0;
    const pending = new Map();
    const queue = [];
    for (const x of workers) {
      x.w.on("message", (msg) => {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        x.busy = false;
        pump();
        if (!p) return;
        if (msg.ok) p.resolve(msg);
        else { const err = new Error(msg.error); err.needsMain = msg.needsMain; p.reject(err); }
      });
      x.w.on("error", (err) => {
        // worker morto: rejeita o que estava com ele e tira do pool
        for (const [id, p] of pending) if (p.worker === x) { pending.delete(id); p.reject(err); }
        const i = workers.indexOf(x);
        if (i >= 0) workers.splice(i, 1);
        pump();
      });
    }
    function pump() {
      while (queue.length) {
        const free = workers.find((x) => !x.busy);
        if (!free) return;
        const job = queue.shift();
        free.busy = true;
        pending.set(job.msg.id, Object.assign(job, { worker: free }));
        free.w.postMessage(job.msg, job.transfer || []);
      }
    }
    function send(msg, transfer) {
      return new Promise((resolve, reject) => {
        msg.id = ++seq;
        queue.push({ msg, transfer, resolve, reject });
        pump();
      });
    }
    /** Manda a mesma mensagem a TODOS os workers (ex.: o índice da votação). */
    function broadcast(msg) {
      return Promise.all(workers.map((x) => new Promise((resolve, reject) => {
        const m = Object.assign({}, msg, { id: ++seq });
        pending.set(m.id, { resolve, reject, worker: x, msg: m });
        x.w.postMessage(m);
      })));
    }

    return {
      parallel: workers.length > 0,
      size: workers.length || 1,
      /** Por que ficou sem workers (null quando há workers). */
      reason: workers.length ? null : reason,
      /** Lê um arquivo num worker; null = rode na thread principal (sem worker ou formato que precisa do decodificador do painel). */
      async analyze(path) {
        if (!workers.length) return null;
        try {
          const r = await send({ type: "analyze", path });
          return r.feat;
        } catch (err) {
          if (err.needsMain) return null;
          throw err;
        }
      },
      /** Executor de janelas de GCC para syncMatch.gccMany. */
      runner: workers.length
        ? async (jobs) => {
          const n = workers.length;
          const chunk = Math.max(8, Math.ceil(jobs.length / (n * 3)));
          const parts = [];
          for (let i = 0; i < jobs.length; i += chunk) parts.push(jobs.slice(i, i + chunk));
          const res = await Promise.all(parts.map((p) => send({ type: "gcc", jobs: p }).then((r) => r.results)));
          return [].concat(...res);
        }
        : null,
      /** Votação das impressões dividida entre os workers (syncMatch, opção voter). */
      voter: workers.length
        ? async (index, params) => {
          await broadcast({ type: "setIndex", index });
          // fatias com quantidade parecida de impressões (fontes longas pesam mais)
          const target = index.total / (workers.length * 4);
          const ranges = [];
          let from = 0;
          for (let s = 0; s < index.nSources; s++) {
            if (index.srcStart[s + 1] - index.srcStart[from] >= target || s === index.nSources - 1) {
              ranges.push([from, s + 1]);
              from = s + 1;
            }
          }
          return Promise.all(ranges.map(([a, b]) => send({ type: "vote", from: a, to: b, params }).then((r) => r.result)));
        }
        : null,
      close() { workers.forEach((x) => x.w.terminate()); workers.length = 0; },
    };
  }
  return { create };
});
