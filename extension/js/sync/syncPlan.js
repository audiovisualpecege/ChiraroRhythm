/**
 * syncPlan.js
 *
 * Dos casamentos (syncMatch) à posição final de cada clipe — a "corrente
 * cronológica" combinada com o usuário:
 *
 *  - Fonte = arquivo de mídia numa faixa (pedaços do mesmo arquivo na faixa
 *    andam juntos, mantendo a distância original entre eles).
 *  - Grupos: fontes ligadas por casamentos, dos mais confiáveis para os
 *    menos. Uma ligação só entra se o grupo continuar respeitando a ordem da
 *    faixa (sem inversão e sem sobreposição); ligações que contradizem o que
 *    o grupo já sabe viram "conflito".
 *  - Corrente: cada grupo entra o mais cedo possível, depois do que vem antes
 *    dele em cada faixa (tempo morto some). Resolvido como um sistema de
 *    restrições de diferença (caminho mais longo / Bellman-Ford); se as
 *    faixas discordarem da ordem entre grupos (ciclo), o grupo mais fraco do
 *    ciclo se desfaz e os clipes dele viram órfãos.
 *  - Órfãos acompanham o clipe anterior da faixa mantendo a distância
 *    original; os que vêm antes do 1º clipe sincronizado da faixa acompanham
 *    o seguinte.
 *  - Tudo no quadro inteiro; o 1º clipe fica no 00:00.
 *
 * Lógica pura: testável em Node.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncPlan = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  /**
   * @param items [{ id, track, index, start, end, inPoint, path, excluded? }]
   *        index = posição do clipe na faixa (ordem original)
   * @param matches [{ a:{track,media}, b:{track,media}, offset, quality, corr, votes, driftSec }]
   * @param opts { fps, tolFrames=2 }
   */
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

  async function buildPlan(items, matches, opts) {
    let lastYield = Date.now();
    const tick = async (frac) => {
      if (Date.now() - lastYield < 40) return;
      if (opts.onProgress) opts.onProgress(frac);
      await yieldToUi();
      lastYield = Date.now();
      if (opts.isCancelled && opts.isCancelled()) throw new Error("cancelado");
    };
    const fps = opts.fps;
    const frame = 1 / fps;
    const o = Object.assign({ minWeakVotes: 6 }, opts);
    const tol = (opts.tolFrames || 2) * frame;
    const forcedOrphans = new Set(opts.forcedOrphans || []); // ids de clipes

    // ------------------------------------------------------------ fontes
    const srcIndex = new Map();
    const sources = [];
    for (const it of items) {
      const k = it.track + "|" + it.path;
      let s = srcIndex.get(k);
      if (s == null) {
        s = sources.length;
        srcIndex.set(k, s);
        sources.push({ id: s, track: it.track, path: it.path, clips: [] });
      }
      sources[s].clips.push(it);
    }
    for (const s of sources) {
      s.clips.sort((x, y) => x.index - y.index);
      const first = s.clips[0];
      // posição relativa de cada pedaço = distância original até o 1º pedaço
      for (const c of s.clips) c._rel = c.start - first.start;
      s.inFirst = first.inPoint;
      s.locked = s.clips.some((c) => c.excluded || forcedOrphans.has(c.id));
    }
    const byTrack = new Map();
    for (const it of items) {
      if (!byTrack.has(it.track)) byTrack.set(it.track, []);
      byTrack.get(it.track).push(it);
    }
    for (const arr of byTrack.values()) arr.sort((x, y) => x.index - y.index);
    const itemSrc = new Map(items.map((it) => [it.id, srcIndex.get(it.track + "|" + it.path)]));

    // ------------------------------------------------------------ arestas
    // offset de mídia D -> diferença entre "starts do 1º pedaço" das fontes
    // aceita a saída de syncMatch.findMatches ({ matches, pending, verify }) ou uma lista simples
    const strongList = Array.isArray(matches) ? matches : matches.matches;
    const pending = Array.isArray(matches) ? [] : matches.pending || [];
    const verifyMany = Array.isArray(matches) ? null : matches.verifyMany;
    const verify = verifyMany; // só para saber se há verificação
    for (const p of pending) { p._tried = false; p._why = null; p._m = null; } // o plano pode ser refeito
    const edges = [];
    for (const m of strongList) {
      const sa = srcIndex.get(m.a.track + "|" + m.a.media);
      const sb = srcIndex.get(m.b.track + "|" + m.b.media);
      if (sa == null || sb == null) continue;
      if (sources[sa].locked || sources[sb].locked) continue;
      const d = m.offset + sources[sb].inFirst - sources[sa].inFirst; // startB − startA
      edges.push({ a: sa, b: sb, d, m });
    }
    edges.sort((x, y) => y.m.quality - x.m.quality);

    // ------------------------------------------------------------ grupos
    let parent, pos, members, groupQuality, accepted, merges, conflicts;
    const find = (x) => {
      while (parent[x] !== x) x = parent[x];
      return x;
    };
    const banned = new Set(); // ligações descartadas por contradizer a ordem das faixas

    const clipSpan = (s, p) => s.clips.map((c) => ({ c, st: p + c._rel, en: p + c._rel + (c.end - c.start) }));

    function orderOk(memberIds, posOf) {
      // por faixa: clipes do grupo em ordem de índice com início crescente e sem sobreposição
      const per = new Map();
      for (const id of memberIds) {
        for (const x of clipSpan(sources[id], posOf(id))) {
          if (!per.has(x.c.track)) per.set(x.c.track, []);
          per.get(x.c.track).push(x);
        }
      }
      for (const arr of per.values()) {
        arr.sort((u, v) => u.c.index - v.c.index);
        for (let i = 1; i < arr.length; i++) {
          if (arr[i].st < arr[i - 1].en - tol) return false;
        }
      }
      return true;
    }

    function buildGroups() {
      parent = sources.map((s) => s.id);
      pos = sources.map(() => 0); // posição relativa ao representante
      members = sources.map((s) => [s.id]);
      groupQuality = sources.map(() => 0);
      accepted = [];
      merges = [];
      conflicts = [];
      let spans = null; // faixa -> [menor, maior índice] por grupo (para as ligações fracas)
      edges.forEach((e, ei) => {
        if (banned.has(ei)) return;
        const ra = find(e.a), rb = find(e.b);
        const pa = posOf(e.a), pb = posOf(e.b);
        if (ra === rb) {
          if (Math.abs(pb - pa - e.d) > tol) conflicts.push({ edge: e, expected: pb - pa });
          else if (!e.m.weak) accepted.push(e);
          return;
        }
        if (e.m.weak) {
          // fraca: só entra se ficar "entre os mesmos vizinhos" — não pode inverter a
          // ordem em relação a nenhum grupo já formado por ligações fortes
          if (!spans) {
            spans = new Map();
            for (let s = 0; s < sources.length; s++) {
              const r = find(s);
              if (members[r].length > 1 && !spans.has(r)) spans.set(r, spanOf(members[r]));
            }
          }
          const mine = spanOf(members[ra].concat(members[rb]));
          for (const [r, sp] of spans) {
            if (r === ra || r === rb) continue;
            if (inverted(mine, sp)) {
              conflicts.push({ edge: e, context: true });
              return;
            }
          }
        }
        // b' = a + d  =>  todos do grupo de b deslocam (pa + d − pb)
        const shift = pa + e.d - pb;
        const merged = members[ra].concat(members[rb]);
        const tmp = (id) => (find(id) === rb ? posOf(id) + shift : posOf(id));
        if (!orderOk(merged, tmp)) {
          conflicts.push({ edge: e, order: true });
          return;
        }
        // une: rb passa a filho de ra (posOf(rb) = 0 no grupo dele -> shift)
        parent[rb] = ra;
        pos[rb] = shift;
        members[ra] = merged;
        members[rb] = [];
        groupQuality[ra] = Math.max(groupQuality[ra], groupQuality[rb], e.m.quality);
        accepted.push(e);
        merges.push(ei);
        if (spans) {
          spans.delete(rb);
          spans.set(ra, spanOf(merged));
        }
      });
      leastSquares();
      rebuildGroups();
    }
    function posOf(x) {
      let p = 0;
      while (parent[x] !== x) {
        p += pos[x];
        x = parent[x];
      }
      return p;
    }

    // ------------------------------------------------- mínimos quadrados por grupo
    // A árvore de ligações acumula erro; com todas as ligações aceitas do grupo
    // (ponderadas pela qualidade) cada fonte fica no ponto que melhor concorda
    // com todas elas. Só ligações de precisão (GCC-PHAT) entram aqui.
    function leastSquares() {
      const adj = new Map();
      for (const e of accepted) {
        if (e.m.precise === false) continue;
        const w = e.m.quality;
        if (!adj.has(e.a)) adj.set(e.a, []);
        if (!adj.has(e.b)) adj.set(e.b, []);
        // P[b] = P[a] + d
        adj.get(e.a).push({ n: e.b, d: -e.d, w });
        adj.get(e.b).push({ n: e.a, d: e.d, w });
      }
      const P = sources.map((s) => posOf(s.id));
      for (let it = 0; it < 60; it++) {
        for (const [id, list] of adj) {
          if (find(id) === id) continue; // representante fica fixo
          let sw = 0, sp = 0;
          for (const x of list) {
            sw += x.w;
            sp += x.w * (P[x.n] + x.d);
          }
          if (sw > 0) P[id] = sp / sw;
        }
      }
      for (const s of sources) {
        const r = find(s.id);
        if (r !== s.id) {
          pos[s.id] = P[s.id] - P[r];
          parent[s.id] = r;
        }
      }
    }

    // ------------------------------------------------------------ corrente
    let groups = new Map(); // raiz -> { members, quality }
    function rebuildGroups() {
      groups = new Map();
      for (const s of sources) {
        const r = find(s.id);
        if (!groups.has(r)) groups.set(r, { root: r, members: [], quality: groupQuality[r] });
        groups.get(r).members.push(s.id);
      }
    }

    /** faixa -> [menor, maior índice] dos clipes das fontes dadas */
    function spanOf(ids) {
      const per = new Map();
      for (const id of ids) for (const c of sources[id].clips) {
        const x = per.get(c.track) || [Infinity, -Infinity];
        x[0] = Math.min(x[0], c.index);
        x[1] = Math.max(x[1], c.index);
        per.set(c.track, x);
      }
      return per;
    }
    /** Um vem antes do outro numa faixa e depois em outra? */
    function inverted(p, q) {
      let before = false, after = false;
      for (const [t, x] of p) {
        const y = q.get(t);
        if (!y) continue;
        if (x[1] < y[0]) before = true;
        else if (y[1] < x[0]) after = true;
      }
      return before && after;
    }

    /** Pares de grupos em ordem invertida entre duas faixas (A antes de B numa, depois na outra). */
    function contradictions() {
      const span = [];
      for (const [r, g] of groups) if (g.members.length > 1) span.push({ r, per: spanOf(g.members) });
      const out = [];
      for (let i = 0; i < span.length; i++) for (let j = i + 1; j < span.length; j++) {
        if (inverted(span[i].per, span[j].per)) out.push([span[i].r, span[j].r]);
      }
      return out;
    }

    /** Descarta a ligação mais fraca que mantém o grupo r unido (ele se divide). */
    function banWeakest(r, why, other) {
      const inGroup = merges.filter((ei) => find(edges[ei].a) === r);
      if (!inGroup.length) return false;
      inGroup.sort((x, y) => edges[x].m.quality - edges[y].m.quality);
      banned.add(inGroup[0]);
      dissolved.push({ root: r, why, members: groups.get(r).members.slice(), edge: edges[inGroup[0]], cycle: (other || []).map((g) => ({ root: g, members: (groups.get(g) || { members: [] }).members.slice() })) });
      return true;
    }

    const dissolved = [];
    const relaxed = new Set();
    let layout = null;

    function resolve() {
      buildGroups();
      for (let attempt = 0; attempt < 600; attempt++) {
        // 1. contradições diretas entre dois grupos: o grupo mais envolvido (e mais fraco) perde uma ligação
        const bad = contradictions();
        if (bad.length) {
          const count = new Map();
          for (const [x, y] of bad) {
            count.set(x, (count.get(x) || 0) + 1);
            count.set(y, (count.get(y) || 0) + 1);
          }
          const culprit = [...count.keys()].sort((x, y) => count.get(y) - count.get(x) || groups.get(x).quality - groups.get(y).quality)[0];
          const partners = bad.filter((p) => p.includes(culprit)).map((p) => (p[0] === culprit ? p[1] : p[0]));
          if (!banWeakest(culprit, "ordem invertida", partners)) break;
          relaxed.clear();
          buildGroups();
          continue;
        }
        // 2. corrente; ciclo mais longo -> o grupo mais fraco do ciclo perde uma ligação
        layout = solveChain();
        if (layout.ok) break;
        if (layout.relaxedOnly) continue;
        const cand = layout.cycleGroups.filter((r) => groups.get(r).members.length > 1);
        if (!cand.length) break;
        cand.sort((x, y) => groups.get(x).quality - groups.get(y).quality);
        if (!banWeakest(cand[0], "ciclo", layout.cycleGroups)) break;
        relaxed.clear();
        buildGroups();
      }
    }

    // 1ª rodada: só ligações fortes
    resolve();
    await tick(0.02);

    // 2ª rodada — contexto de ordem. Para cada par de faixas, escolhe o
    // conjunto de pares candidatos de maior peso que respeita a ordem nas DUAS
    // faixas (cadeia monótona, como um alinhamento de sequências), ancorado
    // nos grupos fortes. Coincidências raramente cabem nessa cadeia; pares reais
    // se encaixam. Só os escolhidos passam pelo GCC-PHAT (posição precisa);
    // os aceitos sem confirmação forte ficam marcados "revisar".
    let verified = 0, checked = 0, review = 0;
    // em rodadas: cada par aceito vira âncora e aperta o contexto da próxima
    for (let round = 0; round < 3 && pending.length && verify; round++) {
      const before = verified;
      const idxOf = (s) => sources[s].clips[0].index;
      const byPair = new Map(); // "t1|t2" -> [{ i, j, w, p? }]
      const add = (s, u, w, p) => {
        let t1 = sources[s].track, t2 = sources[u].track;
        let i = idxOf(s), j = idxOf(u);
        if (t1 > t2) { [t1, t2] = [t2, t1]; [i, j] = [j, i]; }
        const k = t1 + "|" + t2;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push({ i, j, w, p });
      };
      // âncoras: pares de fontes de faixas diferentes já no mesmo grupo forte
      for (const [, g] of groups) {
        if (g.members.length < 2) continue;
        for (let x = 0; x < g.members.length; x++) for (let y = x + 1; y < g.members.length; y++) {
          if (sources[g.members[x]].track !== sources[g.members[y]].track) add(g.members[x], g.members[y], 1e6, null);
        }
      }
      for (const p of pending) {
        if (p._tried) continue;
        const sa = srcIndex.get(p.a.track + "|" + p.a.media);
        const sb = srcIndex.get(p.b.track + "|" + p.b.media);
        if (sa == null || sb == null || sources[sa].locked || sources[sb].locked) { p._why = "fonte"; continue; }
        if (find(sa) === find(sb)) { p._why = "mesmo grupo"; continue; }
        if (p.votes < o.minWeakVotes) { p._why = "poucos votos"; continue; }
        p._sa = sa; p._sb = sb;
        p._why = "fora da cadeia";
        add(sa, sb, p.votes * Math.min(2, Math.max(0.1, (p.ratio === Infinity ? 3 : p.ratio) - 1)), p);
      }
      // cadeia de maior peso, não decrescente em i e em j (árvore de Fenwick de máximos)
      const chosen = [];
      for (const list of byPair.values()) {
        list.sort((x, y) => x.i - y.i || x.j - y.j);
        const maxJ = list.reduce((m, x) => Math.max(m, x.j), 0) + 2;
        const bit = new Float64Array(maxJ + 1).fill(0);
        const bitArg = new Int32Array(maxJ + 1).fill(-1);
        const best = new Float64Array(list.length);
        const prev = new Int32Array(list.length).fill(-1);
        const query = (j) => { let v = 0, a = -1; for (let k = j + 1; k > 0; k -= k & -k) if (bit[k] > v) { v = bit[k]; a = bitArg[k]; } return [v, a]; };
        const update = (j, v, a) => { for (let k = j + 1; k <= maxJ; k += k & -k) if (v > bit[k]) { bit[k] = v; bitArg[k] = a; } };
        let top = -1;
        for (let n = 0; n < list.length; n++) {
          const [v, a] = query(list[n].j);
          best[n] = v + list[n].w;
          prev[n] = a;
          update(list[n].j, best[n], n);
          if (top < 0 || best[n] > best[top]) top = n;
        }
        for (let n = top; n >= 0; n = prev[n]) if (list[n].p) chosen.push(list[n].p);
      }
      // verificação: posição pelo GCC; confirmação forte ou "revisar". Em lotes
      // (as janelas de GCC de um lote rodam em paralelo, se houver workers).
      const LOTE = 200;
      const results = [];
      for (let k = 0; k < chosen.length; k += LOTE) {
        await tick(Math.min(0.95, (round + k / Math.max(1, chosen.length)) / 3));
        results.push(...(await verifyMany(chosen.slice(k, k + LOTE), true)));
      }
      for (let ci = 0; ci < chosen.length; ci++) {
        const p = chosen[ci];
        p._why = "verificado";
        p._tried = true;
        checked++;
        const m = results[ci];
        if (!m) { p._why = "sem evidência"; continue; }
        p._m = m;
        verified++;
        if (m.review) review++;
        edges.push({ a: p._sa, b: p._sb, d: m.offset + sources[p._sb].inFirst - sources[p._sa].inFirst, m });
      }
      edges.sort((x, y) => y.m.quality - x.m.quality);
      banned.clear(); // índices mudaram com a reordenação
      dissolved.length = 0;
      resolve();
      if (verified === before) break;
    }
    if (opts.log) opts.log(`pendentes: ${pending.length} · escolhidos pela cadeia de ordem: ${checked} · aceitos: ${verified} (a revisar: ${review})`);

    // ------------------------------------------------- tempo real (relógios)
    // O espaço entre grupos e o lugar dos órfãos seguem o tempo real, com o
    // tempo morto comprimido. O relógio de cada aparelho é corrigido pelo que o
    // áudio sincronizou (por trechos: um salto > 2 s abre um trecho novo).
    const clock = layout && layout.ok ? clockLayout() : null;
    if (clock && clock.desiredU.size) {
      const L2 = solveChain(clock.desiredU);
      if (L2.ok) layout = L2;
    }

    function clockLayout() {
      const JOIN = o.joinGapSec != null ? o.joinGapSec : 30;
      const RATIO = o.gapRatio != null ? o.gapRatio : 0.15;
      const MAXG = o.maxGapSec != null ? o.maxGapSec : 600;
      const JUMP = 2; // s — diferença que indica salto de relógio
      const clipClock = (c) => (c.clock != null && isFinite(c.clock) ? c.clock + (c.inPoint || 0) : null);
      if (!items.some((c) => clipClock(c) != null)) return null;
      const relSrc = sources.map((s) => posOf(s.id));
      const posC = (c) => relSrc[itemSrc.get(c.id)] + c._rel;
      const groupOf = (c) => { const r = find(itemSrc.get(c.id)); return groups.get(r).members.length > 1 ? r : null; };

      // medições: F_grupo + O_aparelho = relógio(c) − pos(c), por (grupo, aparelho)
      const meas = new Map(); // "r|dev" -> { r, dev, ms:[], idx:[] }
      for (const c of items) {
        const r = groupOf(c), k = clipClock(c);
        if (r == null || k == null) continue;
        const key = r + "|" + c.track;
        if (!meas.has(key)) meas.set(key, { r, dev: c.track, ms: [], idx: [] });
        const m = meas.get(key);
        m.ms.push(k - posC(c));
        m.idx.push(c.index);
      }
      if (!meas.size) return null;
      const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
      const edgesC = [...meas.values()].map((m) => ({ r: m.r, dev: m.dev, m: med(m.ms), idx: med(m.idx), n: m.ms.length }));

      // grupo principal: o com mais clipes
      let mainRoot = null, best = -1;
      for (const [r, g] of groups) {
        if (g.members.length < 2) continue;
        const n = g.members.reduce((s, id) => s + sources[id].clips.length, 0);
        if (n > best) { best = n; mainRoot = r; }
      }

      // resolve F (grupos) e O (trechos de aparelho) por busca a partir do principal
      function solve(segOf) {
        const F = new Map([[mainRoot, 0]]), O = new Map();
        const adjG = new Map(), adjS = new Map();
        for (const e of edgesC) {
          const s = segOf(e);
          if (!adjG.has(e.r)) adjG.set(e.r, []);
          if (!adjS.has(s)) adjS.set(s, []);
          adjG.get(e.r).push({ s, m: e.m, n: e.n });
          adjS.get(s).push({ r: e.r, m: e.m, n: e.n });
        }
        const queue = [{ g: mainRoot }];
        while (queue.length) {
          const q = queue.shift();
          if (q.g != null) {
            for (const x of (adjG.get(q.g) || []).slice().sort((a, b) => b.n - a.n)) {
              if (O.has(x.s)) continue;
              O.set(x.s, x.m - F.get(q.g));
              queue.push({ s: x.s });
            }
          } else {
            for (const x of (adjS.get(q.s) || []).slice().sort((a, b) => b.n - a.n)) {
              if (F.has(x.r)) continue;
              F.set(x.r, x.m - O.get(q.s));
              queue.push({ g: x.r });
            }
          }
        }
        // refino: cada nó = mediana do que as ligações dizem (menos sensível a um par ruim)
        for (let it = 0; it < 4; it++) {
          for (const [r] of F) {
            if (r === mainRoot) continue;
            const v = (adjG.get(r) || []).filter((x) => O.has(x.s)).map((x) => x.m - O.get(x.s));
            if (v.length) F.set(r, med(v));
          }
          for (const [s] of O) {
            const v = (adjS.get(s) || []).filter((x) => F.has(x.r)).map((x) => x.m - F.get(x.r));
            if (v.length) O.set(s, med(v));
          }
        }
        return { F, O };
      }

      // 1ª passada: um relógio por aparelho; depois divide onde o resíduo salta
      let segOf = (e) => e.dev + "#0";
      let sol = solve(segOf);
      const segEdges = new Map(); // dev -> [{ idx, seg }]
      const byDev = new Map();
      for (const e of edgesC) { if (!byDev.has(e.dev)) byDev.set(e.dev, []); byDev.get(e.dev).push(e); }
      for (const [dev, list] of byDev) {
        list.sort((a, b) => a.idx - b.idx);
        let seg = 0, base = null;
        const out = [];
        for (const e of list) {
          const res = sol.F.has(e.r) && sol.O.has(dev + "#0") ? e.m - sol.F.get(e.r) - sol.O.get(dev + "#0") : null;
          if (res != null) {
            if (base != null && Math.abs(res - base) > JUMP) seg++;
            base = res;
          }
          e.seg = dev + "#" + seg;
          out.push({ idx: e.idx, seg: e.seg });
        }
        segEdges.set(dev, out);
      }
      segOf = (e) => e.seg;
      sol = solve(segOf);
      const { F, O } = sol;

      // trecho de relógio de um clipe: o da medição mais próxima na ordem da faixa
      const segFor = (c) => {
        const list = (segEdges.get(c.track) || []).filter((x) => O.has(x.seg));
        if (!list.length) return null;
        let bestS = list[0];
        for (const x of list) if (Math.abs(x.idx - c.index) < Math.abs(bestS.idx - c.index)) bestS = x;
        return bestS.seg;
      };

      // intervalos reais: grupos (inteiros) e órfãos com relógio de referência
      const spans = [];
      const groupSpan = new Map();
      for (const [r, g] of groups) {
        if (g.members.length < 2 || !F.has(r)) continue;
        let a = Infinity, b = -Infinity;
        for (const id of g.members) for (const c of sources[id].clips) {
          a = Math.min(a, posC(c));
          b = Math.max(b, posC(c) + (c.end - c.start));
        }
        groupSpan.set(r, { minPos: a, s: F.get(r) + a, e: F.get(r) + b });
        spans.push([F.get(r) + a, F.get(r) + b]);
      }
      const orphanReal = new Map(); // id -> início real
      const noRef = new Set();
      const noClock = new Set();
      for (const c of items) {
        if (groupOf(c) != null) continue;
        const k = clipClock(c);
        if (k == null) { noClock.add(c.id); continue; }
        const seg = segFor(c);
        if (seg == null) { noRef.add(c.id); continue; }
        const real = k - O.get(seg);
        orphanReal.set(c.id, real);
        // órfão conta como um ponto no tempo (só os grupos seguram o tempo real):
        // o tempo coberto só por órfãos também é comprimido — como o Syncalia,
        // que deixa os órfãos de uma câmera encostados
        // Peso 0,5 calibrado no gabarito: com 30 s / 15% a duração e os vãos
        // ficam parecidos com os do Syncalia (5,03 h × 5,13 h no casamento)
        spans.push([real, real + (c.end - c.start) * (o.orphanWeight != null ? o.orphanWeight : 0.5)]);
      }
      if (!spans.length) return null;

      // compressão do tempo morto: vão real g -> vão na timeline
      spans.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
        else merged.push([s[0], s[1]]);
      }
      const squeeze = (g) => (g <= JOIN ? 0 : Math.min(MAXG, g * RATIO));
      const removedBefore = [0];
      for (let i = 1; i < merged.length; i++) {
        const g = merged[i][0] - merged[i - 1][1];
        removedBefore.push(removedBefore[i - 1] + (g - squeeze(g)));
      }
      const map = (R) => {
        let lo = 0, hi = merged.length - 1, i = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (merged[mid][0] <= R + 1e-9) { i = mid; lo = mid + 1; } else hi = mid - 1; }
        return R - merged[0][0] - removedBefore[i];
      };

      const desiredU = new Map();
      for (const [r, sp] of groupSpan) desiredU.set(r, map(sp.s) - sp.minPos);
      const orphanAt = new Map();
      for (const [id, real] of orphanReal) orphanAt.set(id, map(real));
      const segCount = new Set([...O.keys()]).size;
      if (opts.log) opts.log(`relógios: ${segCount} trecho(s) de aparelho corrigido(s) · grupos no tempo real ${desiredU.size} · órfãos no tempo real ${orphanAt.size} · sem referência ${noRef.size} · tempo morto removido ${(removedBefore[removedBefore.length - 1] / 60).toFixed(0)} min`);
      return { desiredU, orphanAt, noRef, noClock };
    }

    function solveChain(desired) {
      // variável por grupo (raiz): U = start do representante; clipe = U + relSrc + _rel
      // desired (opcional): Map raiz -> U mínimo vindo do relógio corrigido
      const roots = [...groups.keys()];
      const gi = new Map(roots.map((r, i) => [r, i]));
      const relSrc = sources.map((s) => posOf(s.id));
      const clipStartRel = (c) => relSrc[itemSrc.get(c.id)] + c._rel;
      const clipGroup = (c) => gi.get(find(itemSrc.get(c.id)));
      const synced = (c) => groups.get(find(itemSrc.get(c.id))).members.length > 1;

      // restrições U_y − U_x ≥ w
      const cons = [];
      const lower = new Float64Array(roots.length).fill(0); // U + relMin ≥ espaço inicial
      for (const [track, arr] of byTrack) {
        void track;
        // âncoras da faixa: clipes sincronizados (ou, se não houver, o 1º clipe)
        const anchors = arr.filter(synced);
        if (!anchors.length) continue;
        // espaço antes da 1ª âncora (órfãos iniciais)
        const firstA = anchors[0];
        let lead = 0;
        for (let k = 0; k < arr.length && arr[k] !== firstA; k++) lead += arr[k].end - arr[k].start + gapBefore(arr, k + 1);
        const g0 = clipGroup(firstA);
        lower[g0] = Math.max(lower[g0], lead - clipStartRel(firstA));
        // entre âncoras consecutivas da faixa
        for (let k = 1; k < anchors.length; k++) {
          const A1 = anchors[k - 1], A2 = anchors[k];
          const ga = clipGroup(A1), gb = clipGroup(A2);
          // espaço mínimo: órfãos entre elas encostados (sem os vãos originais)
          let need = 0;
          for (let x = arr.indexOf(A1) + 1; arr[x] !== A2; x++) need += arr[x].end - arr[x].start;
          const w = clipStartRel(A1) + (A1.end - A1.start) - clipStartRel(A2);
          // dentro do mesmo grupo a distância já está fixada pelo áudio; se os
          // órfãos do meio não couberem, eles se apertam depois (aviso)
          if (ga === gb) continue;
          const key = ga + ">" + gb;
          cons.push({ x: ga, y: gb, w: w + (relaxed.has(key) ? 0 : need), key });
        }
      }
      // posição pelo tempo real (relógios corrigidos): é um piso, a ordem das faixas ainda manda
      if (desired) {
        roots.forEach((r, g) => { if (desired.has(r)) lower[g] = Math.max(lower[g], desired.get(r)); });
      }
      // grupos/fontes sem nenhum clipe sincronizado: só órfãos (tratados depois)
      // caminho mais longo (Bellman-Ford)
      const U = Float64Array.from(lower);
      const n = roots.length;
      const pred = new Int32Array(n).fill(-1); // restrição que deu o valor atual
      let changed = true;
      let iter = 0;
      let lastNode = -1;
      while (changed && iter <= n + 1) {
        changed = false;
        for (let ci = 0; ci < cons.length; ci++) {
          const c = cons[ci];
          const v = U[c.x] + c.w;
          if (v > U[c.y] + 1e-9) {
            U[c.y] = v;
            pred[c.y] = ci;
            changed = true;
            lastNode = c.y;
          }
        }
        iter++;
      }
      if (changed) {
        // ciclo positivo de verdade: anda n vezes pelos predecessores (cai dentro
        // do ciclo) e depois percorre o ciclo
        let v = lastNode;
        for (let k = 0; k < n; k++) v = cons[pred[v]].x;
        const cyc = [];
        const seen = new Set();
        let u = v;
        while (!seen.has(u)) {
          seen.add(u);
          cyc.push(pred[u]);
          u = cons[pred[u]].x;
        }
        // 1º tenta abrir mão do espaço dos órfãos nas restrições do ciclo
        const fresh = cyc.map((ci) => cons[ci].key).filter((k) => !relaxed.has(k));
        if (fresh.length) {
          for (const k of fresh) relaxed.add(k);
          return { ok: false, relaxedOnly: true, cycleGroups: [] };
        }
        return { ok: false, cycleGroups: [...seen].map((i) => roots[i]) };
      }
      return { ok: true, U, gi, roots, relSrc, clipStartRel, clipGroup, synced };
    }

    function gapBefore(arr, k) {
      // distância original entre arr[k−1] e arr[k] (0 se encostados ou sobrepostos)
      if (k <= 0 || k >= arr.length) return 0;
      return Math.max(0, arr[k].start - arr[k - 1].end);
    }

    // ------------------------------------------------------------ posições
    const placed = new Array(items.length);
    const byId = new Map(items.map((it, i) => [it.id, i]));
    const L = layout;
    const warnings = [];
    const outOfOrder = new Set();
    for (const [, arr] of byTrack) {
      const isSync = arr.map((c) => L.ok && L.synced(c));
      const st = new Float64Array(arr.length).fill(NaN);
      for (let k = 0; k < arr.length; k++) {
        if (isSync[k]) st[k] = L.U[L.clipGroup(arr[k])] + L.clipStartRel(arr[k]);
      }
      const firstSync = isSync.indexOf(true);
      if (firstSync < 0) {
        // faixa sem nada sincronizado: mantém as posições originais relativas, a partir do 0
        const base = arr.length ? arr[0].start : 0;
        for (let k = 0; k < arr.length; k++) st[k] = arr[k].start - base;
      } else {
        // órfãos iniciais: acompanham o seguinte (para trás)
        for (let k = firstSync - 1; k >= 0; k--) st[k] = st[k + 1] - gapBefore(arr, k + 1) - (arr[k].end - arr[k].start);
        // demais: acompanham o anterior
        for (let k = firstSync + 1; k < arr.length; k++) {
          if (isSync[k]) continue;
          st[k] = st[k - 1] + (arr[k - 1].end - arr[k - 1].start) + gapBefore(arr, k);
        }
        // órfãos com relógio de referência: vão para o seu ponto no tempo real
        // (comprimido), desde que caibam entre os vizinhos da faixa — a ordem
        // da faixa vence; se o horário contradiz a ordem, ficam na regra acima
        if (clock) {
          const nextSyncAfter = (k) => { for (let x = k + 1; x < arr.length; x++) if (isSync[x]) return x; return -1; };
          for (let k = 0; k < arr.length; k++) {
            if (isSync[k]) continue;
            const at = clock.orphanAt.get(arr[k].id);
            if (at == null) continue;
            const lowB = k > 0 ? st[k - 1] + (arr[k - 1].end - arr[k - 1].start) : -Infinity;
            const ns = nextSyncAfter(k);
            let after = 0;
            if (ns >= 0) for (let x = k; x < ns; x++) after += arr[x].end - arr[x].start;
            const upB = ns >= 0 ? st[ns] - after : Infinity;
            // ordem contrariada (o relógio diz que veio antes do anterior ou depois
            // do próximo sincronizado) → regra antiga; só não cabe → encosta
            const nextStart = ns >= 0 ? st[ns] : Infinity;
            if (at < lowB - 2 || at > nextStart + 2) { outOfOrder.add(arr[k].id); if (k > 0 && k > firstSync) st[k] = lowB + gapBefore(arr, k); continue; }
            st[k] = lowB > upB ? lowB : Math.min(Math.max(at, lowB), upB);
          }
        }
        // sem espaço antes do próximo sincronizado: encolhe os vãos; se não der, avisa
        for (let k = firstSync + 1; k < arr.length; k++) {
          if (!isSync[k]) continue;
          let j = k - 1;
          while (j >= 0 && !isSync[j]) j--;
          if (j === k - 1) continue;
          const lastOrphanEnd = st[k - 1] + (arr[k - 1].end - arr[k - 1].start);
          if (lastOrphanEnd <= st[k] + 1e-6) continue;
          // reencosta os órfãos no anterior sem vãos
          let cur = st[j] + (arr[j].end - arr[j].start);
          for (let x = j + 1; x < k; x++) {
            st[x] = cur;
            cur += arr[x].end - arr[x].start;
          }
          if (cur > st[k] + tol) warnings.push({ type: "sem-espaco", clips: arr.slice(j + 1, k).map((c) => c.id) });
        }
      }
      for (let k = 0; k < arr.length; k++) {
        const c = arr[k];
        const g = L.ok ? find(itemSrc.get(c.id)) : null;
        placed[byId.get(c.id)] = { id: c.id, start: st[k], synced: isSync[k], group: isSync[k] ? g : null };
      }
    }
    // Arquivos seguidos da mesma câmera no mesmo grupo, com vão menor que ~1
    // quadro, são a gravação dividida em arquivos (sem emenda na realidade):
    // encosta o seguinte no fim do anterior ANTES de arredondar ao quadro —
    // senão o arredondamento de cada um sobrepõe por fração de quadro.
    for (const [, arr] of byTrack) {
      for (let k = 1; k < arr.length; k++) {
        const pa = placed[byId.get(arr[k - 1].id)], pb = placed[byId.get(arr[k].id)];
        if (!pa.synced || !pb.synced || pa.group !== pb.group) continue;
        const prevEnd = pa.start + (arr[k - 1].end - arr[k - 1].start);
        if (Math.abs(pb.start - prevEnd) < 1.5 * frame) pb.start = prevEnd;
      }
    }
    // 1º clipe no 00:00 e tudo no quadro
    let min = Infinity;
    for (const p of placed) if (p.start < min) min = p.start;
    for (const p of placed) p.start = Math.round((p.start - min) * fps) / fps;
    // o arredondamento de cada clipe ao quadro pode encostar dois clipes em menos
    // de 1 quadro: empurra o seguinte para o próximo quadro livre
    // Sincronizado nunca é empurrado se der para recuar os órfãos logo antes dele
    // (a posição do órfão é aproximada; a do sincronizado veio do áudio).
    // Um clipe sincronizado nunca é empurrado sozinho (quebraria o sincronismo):
    // recua os órfãos logo antes dele, se houver espaço; senão empurra o GRUPO
    // inteiro (todas as câmeras juntas). Repete até não sobrar sobreposição.
    const pushes = { group: 0, orphan: 0, pulled: 0 };
    const groupClips = new Map();
    placed.forEach((p) => { if (p.synced) { if (!groupClips.has(p.group)) groupClips.set(p.group, []); groupClips.get(p.group).push(p); } });
    for (let pass = 0; pass < 60; pass++) {
      let changed = false;
      for (const [, arr] of byTrack) {
        const P = arr.map((c) => placed[byId.get(c.id)]);
        const dur = arr.map((c) => c.end - c.start);
        for (let k = 1; k < arr.length; k++) {
          const prevEnd = P[k - 1].start + dur[k - 1];
          const over = prevEnd - P[k].start;
          if (!(over > 1e-6)) continue;
          const shift = Math.ceil(over * fps - 1e-6) / fps;
          if (!P[k].synced) {
            P[k].start += shift;
            pushes.orphan++;
            changed = true;
            continue;
          }
          if (!P[k - 1].synced) {
            let j = k - 1;
            while (j > 0 && !P[j - 1].synced && Math.abs(P[j - 1].start + dur[j - 1] - P[j].start) < 1e-6) j--;
            const roomBefore = j === 0 ? Infinity : P[j].start - (P[j - 1].start + dur[j - 1]);
            if (roomBefore >= shift - 1e-6) {
              for (let x = j; x < k; x++) P[x].start -= shift;
              pushes.pulled++;
              changed = true;
              continue;
            }
          }
          for (const q of groupClips.get(P[k].group)) q.start += shift;
          pushes.group++;
          changed = true;
        }
      }
      if (!changed) break;
    }
    if (opts.log) opts.log(`ajustes de quadro (arredondamento): órfãos recuados ${pushes.pulled} · grupos empurrados ${pushes.group} · órfãos empurrados ${pushes.orphan}`);

    // resumo dos grupos
    const groupList = [];
    for (const [r, g] of groups) {
      if (g.members.length < 2) continue;
      groupList.push({ root: r, sources: g.members.length, clips: g.members.reduce((n, id) => n + sources[id].clips.length, 0), quality: g.quality });
    }
    // deriva relevante (> 1 quadro) nas ligações aceitas
    const drift = accepted.filter((e) => Math.abs(e.m.driftSec || 0) > frame).map((e) => ({ a: e.a, b: e.b, driftSec: e.m.driftSec, overlapSec: e.m.overlapSec }));

    // detalhes por clipe para a lista do painel: com quem casou, confiança e
    // se só entrou por ligações fracas ("revisar")
    const bySrc = new Map();
    for (const e of accepted) {
      for (const [me, other] of [[e.a, e.b], [e.b, e.a]]) {
        const cur = bySrc.get(me);
        const strongEdge = !e.m.review;
        const better = !cur || (strongEdge && !cur.strong) || (strongEdge === cur.strong && e.m.quality > cur.q);
        if (better) bySrc.set(me, { other, strong: strongEdge, q: e.m.quality, sharp: e.m.sharp || 0, precise: !!e.m.precise, via: e.m.visual || "áudio" });
        else if (strongEdge) cur.strong = true;
      }
    }
    for (const p of placed) {
      const s = itemSrc.get(p.id);
      const it = items[byId.get(p.id)];
      if (p.synced) {
        const b = bySrc.get(s);
        p.review = !b || !b.strong;
        p.partner = b ? sources[b.other].clips[0].id : null;
        p.sharp = b ? b.sharp : 0;
        p.precise = b ? b.precise : false;
        p.via = b ? b.via : "áudio"; // origem da ligação mais forte: "áudio" ou "boca" (imagem)
      } else {
        p.reason = forcedOrphans.has(p.id) ? "mandado para órfão" : it.noAudio || (sources[s].locked ? "fixo" : "não casou com nenhum outro");
        if (!forcedOrphans.has(p.id) && clock) {
          if (outOfOrder.has(p.id)) p.reason += " · horário fora de ordem";
          else if (clock.noRef.has(p.id)) p.reason += " · relógio sem referência";
          else if (clock.noClock.has(p.id)) p.reason += " · sem relógio";
        }
      }
    }

    return {
      ok: !!(L && L.ok),
      sources,
      placed,
      groups: groupList,
      orphans: placed.filter((p) => !p.synced).length,
      conflicts,
      dissolved,
      warnings,
      drift,
    };
  }

  return { buildPlan };
});
