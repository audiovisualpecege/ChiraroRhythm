/**
 * mcPlan.js — plano da multicâmera: qual câmera fica no ar e quando cada
 * microfone fica ligado (regras combinadas com o usuário em 26/10/2026).
 *
 * Câmeras: quem fala ganha o close dele (sem close: a média que o mostra; sem
 * média: a aberta), cortando ~0,2 s antes da 1ª palavra; plano mínimo; fala
 * curta ("uhum") não muda a câmera; pausa curta = mesma fala; interação (várias
 * trocas ou fala sobreposta) vai para a média da dupla ou para a aberta e sai
 * quando alguém fala sozinho; em fala longa, respiro com a aberta numa pausa.
 * Câmeras equivalentes se alternam. Variação dos respiros é determinística.
 *
 * Microfones: ligado durante a fala (folga antes/depois) e também nas pausas
 * curtas da MESMA pessoa ("hold") — o usuário pediu para não picotar uma fala
 * longa a cada respiração. Vários podem ficar ligados ao mesmo tempo.
 *
 * Tempos em segundos da timeline. Medido no podcast de teste (39 min): ~90 ms.
 */
(function (root, factory) {
  const api = factory();
  root.AEMcPlan = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEF = {
    lead: 0.2,          // corte antes da 1ª palavra (s)
    minShot: 2.5,       // plano mínimo (s)
    shortUtter: 1.5,    // fala menor que isso não muda câmera (s)
    pauseMerge: 1.0,    // pausa menor que isso = mesma fala (s)
    interaction: 0.25,  // 0 = menos interação … 1 = mais (padrão escolhido no banco: 62% de acordo com o corte ao vivo)
    dynamism: 0.25,     // 0 = sem respiros … 1 = mais respiros
    micPad: 0.3,        // folga do microfone antes/depois da fala (s)
    micHold: 3.0,       // pausa da mesma pessoa até isso mantém o microfone ligado (s)
  };
  const STEP = 0.1;

  function utterances(segs, gap) {
    const out = [];
    for (const [a, b] of segs) {
      const last = out[out.length - 1];
      if (last && a - last.e < gap) last.e = b;
      else out.push({ s: a, e: b });
    }
    return out;
  }

  function rng(seed) {
    let x = seed >>> 0 || 1;
    return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  /** close da pessoa → média que inclui todos → aberta; alterna entre equivalentes */
  function camFor(cams, people, alt) {
    const idx = (pred) => cams.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);
    const pick = (list) => (list.length ? list[alt.n++ % list.length] : null);
    if (people.length === 1) {
      const c = pick(idx((c) => c.kind === "close" && c.people.includes(people[0])));
      if (c != null) return c;
    }
    const m = pick(idx((c) => c.kind === "media" && people.every((p) => c.people.includes(p))));
    if (m != null) return m;
    const a = pick(idx((c) => c.kind === "aberta"));
    if (a != null) return a;
    return pick(idx(() => true)); // sem aberta: qualquer câmera
  }

  /**
   * @param {number[][][]} speech  falas por pessoa [[início, fim], …] (s da timeline)
   * @param {{kind:"close"|"media"|"aberta", people:number[]}[]} cams
   * @param {number} from  início do trecho (s)
   * @param {number} to    fim do trecho (s)
   * @returns {{ s:number, e:number, cam:number }[]}  planos cobrindo [from, to]
   */
  function planCameras(speech, cams, from, to, opt) {
    const o = Object.assign({}, DEF, opt || {});
    if (!cams.length || to <= from) return [];
    const nP = speech.length;
    const win = 10, swaps = Math.round(4 - 2 * o.interaction), ovl = 1.5 - o.interaction, takeFloor = 2 + 2 * o.interaction;
    const all = speech.flatMap((s, p) => utterances(s, o.pauseMerge).map((u) => ({ ...u, p }))).sort((a, b) => a.s - b.s);
    const longU = all.filter((u) => u.e - u.s >= o.shortUtter);
    const T = Math.ceil((to - from) / STEP);
    const k0 = (t) => Math.floor((t - from) / STEP);

    // quem tem a palavra: a fala longa que começou por último e ainda está ativa; silêncio mantém
    const floor = new Int8Array(T).fill(-1);
    for (const u of longU) for (let k = Math.max(0, k0(u.s - o.lead)); k < Math.min(T, Math.ceil((u.e - from) / STEP)); k++) floor[k] = u.p;
    for (let k = 1; k < T; k++) if (floor[k] < 0) floor[k] = floor[k - 1];

    // interação: trocas (falas ≥ 0,5 s) e sobreposição numa janela de 10 s
    const turns = all.filter((u) => u.e - u.s >= 0.5);
    const active = new Uint8Array(T * Math.max(1, nP));
    // quem fala a cada momento pelas falas ORIGINAIS (as juntadas tapam as pausas, onde cabe o respiro)
    speech.forEach((segs, p) => { for (const [a, b] of segs) for (let k = Math.max(0, k0(a)); k < Math.min(T, Math.ceil((b - from) / STEP)); k++) active[k * nP + p] = 1; });
    const overlap = new Float32Array(T + 1); // soma acumulada de quadros com 2+ falando
    for (let k = 0; k < T; k++) { let c = 0; for (let p = 0; p < nP; p++) c += active[k * nP + p]; overlap[k + 1] = overlap[k] + (c >= 2 ? STEP : 0); }
    const inter = new Uint8Array(T);
    let lo = 0;
    for (let k = 0; k < T; k++) {
      const t = from + k * STEP, t0 = t - win / 2, t1 = t + win / 2;
      while (lo < turns.length && turns[lo].e < t0 - 60) lo++;
      let ch = 0, last = -1;
      for (let q = lo; q < turns.length && turns[q].s <= t1; q++) { const u = turns[q]; if (u.e < t0) continue; if (u.p !== last) { if (last >= 0) ch++; last = u.p; } }
      const a = Math.max(0, k0(t0)), b = Math.min(T, k0(t1));
      const ov = b > a ? overlap[b] - overlap[a] : 0;
      if (ch >= swaps || ov >= ovl) inter[k] = 1;
    }
    for (const u of longU) {
      if (u.e - u.s < takeFloor) continue;
      let alone = true;
      for (const v of all) { if (v.s > u.s + takeFloor) break; if (v.p !== u.p && v.e > u.s + 0.3) { alone = false; break; } }
      if (alone) for (let k = Math.max(0, k0(u.s + takeFloor)); k < Math.min(T, Math.ceil((u.e - from) / STEP)); k++) inter[k] = 0;
    }

    // câmera desejada
    const alt = { n: 0 };
    const want = new Int8Array(T);
    let curKey = "", curCam = -1;
    for (let k = 0; k < T; k++) {
      let people, key;
      if (inter[k]) {
        const t0 = from + k * STEP - win / 2, t1 = from + k * STEP + win / 2, who = new Set();
        for (const u of turns) { if (u.s > t1) break; if (u.e >= t0) who.add(u.p); }
        people = [...who].sort();
        key = "I" + people.join(",");
        if (people.length !== 2) people = [...Array(nP).keys()];
      } else {
        people = floor[k] >= 0 ? [floor[k]] : [...Array(nP).keys()];
        key = "P" + people.join(",");
      }
      if (key !== curKey) { curKey = key; curCam = camFor(cams, people, alt); }
      want[k] = curCam;
    }
    let shots = [];
    for (let k = 0; k < T; k++) {
      const last = shots[shots.length - 1];
      const s = from + k * STEP, e = Math.min(to, from + (k + 1) * STEP);
      if (last && last.cam === want[k]) last.e = e;
      else shots.push({ s, e, cam: want[k] });
    }

    // respiro com a aberta em fala longa, numa pausa de ≥ 0,3 s
    const open = cams.findIndex((c) => c.kind === "aberta");
    if (open >= 0 && o.dynamism > 0) {
      const r = rng(Math.round((to - from) * 1000));
      const every = 32 - 14 * o.dynamism;
      const silentAt = (k) => { for (let q = k; q < k + 3; q++) { if (q >= T) return false; for (let p = 0; p < nP; p++) if (active[q * nP + p]) return false; } return true; };
      const out = [];
      for (const sh of shots) {
        if (sh.cam === open || sh.e - sh.s < every + 6) { out.push(sh); continue; }
        let t = sh.s, next = sh.s + every * (0.8 + 0.4 * r());
        while (next < sh.e - 6) {
          let best = null;
          for (let k = Math.max(0, k0(next - 4)); k < Math.min(T, k0(next + 4)); k++) if (silentAt(k) && (best == null || Math.abs(from + k * STEP - next) < Math.abs(best - next))) best = from + k * STEP;
          if (best == null) { next += 4; continue; }
          const len = 3 + 2 * r();
          out.push({ s: t, e: best, cam: sh.cam });
          out.push({ s: best, e: best + len, cam: open });
          t = best + len;
          next = t + every * (0.8 + 0.4 * r());
        }
        out.push({ s: t, e: sh.e, cam: sh.cam });
      }
      shots = out;
    }

    // plano mínimo: o curto é absorvido pelo anterior (o 1º, pelo seguinte)
    const merged = [];
    for (const sh of shots) {
      const last = merged[merged.length - 1];
      if (last && (sh.cam === last.cam || sh.e - sh.s < o.minShot)) last.e = sh.e;
      else merged.push({ ...sh });
    }
    if (merged.length > 1 && merged[0].e - merged[0].s < o.minShot) { merged[1].s = merged[0].s; merged.shift(); }
    return merged;
  }

  /** microfone ligado: fala com folga, e pausas da mesma pessoa até `micHold` ficam ligadas */
  function planMics(speech, from, to, opt) {
    const o = Object.assign({}, DEF, opt || {});
    return speech.map((segs) => {
      const out = [];
      for (const [a, b] of segs) {
        const s = Math.max(from, a - o.micPad), e = Math.min(to, b + o.micPad);
        if (e <= s) continue;
        const l = out[out.length - 1];
        if (l && s - l[1] <= o.micHold) l[1] = Math.max(l[1], e);
        else out.push([s, e]);
      }
      return out;
    });
  }

  /** resumo para a prévia */
  function summarize(shots, cams, mics) {
    const total = shots.length ? shots[shots.length - 1].e - shots[0].s : 0;
    const lens = shots.map((s) => s.e - s.s).sort((a, b) => a - b);
    const byKind = { close: 0, media: 0, aberta: 0 };
    for (const s of shots) { const c = cams[s.cam]; if (c) byKind[c.kind] += s.e - s.s; }
    return {
      cuts: Math.max(0, shots.length - 1),
      medianShot: lens.length ? lens[lens.length >> 1] : 0,
      share: { close: total ? byKind.close / total : 0, media: total ? byKind.media / total : 0, aberta: total ? byKind.aberta / total : 0 },
      micCuts: mics.reduce((n, m) => n + m.length, 0),
    };
  }

  return { DEF, planCameras, planMics, summarize, utterances };
});
