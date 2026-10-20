/**
 * interleavePlan.js
 *
 * Lógica pura do Áudio Intercalado (J-Cut / L-Cut). Recebe os clipes da
 * faixa de origem e da faixa de destino e devolve um plano de operações:
 *
 *   - clipes em posição ímpar (2º, 4º, ...) são MOVIDOS para a faixa de destino;
 *   - J-Cut: o áudio do clipe seguinte começa N frames antes do corte;
 *   - L-Cut: o áudio do clipe anterior continua N frames depois do corte;
 *   - Ambos: N frames de cada lado.
 *
 * Se não houver material (handle) na mídia ou espaço na faixa, estica o
 * máximo possível e marca o corte como parcial. Tudo em ticks do Premiere
 * (254016000000 por segundo) para não acumular erro de arredondamento.
 */
(function (root, factory) {
  const api = factory();
  root.AEInterleavePlan = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const TICKS_PER_SECOND = 254016000000;

  /**
   * @param input {
   *   srcTrack, dstTrack, type: "J"|"L"|"both", frames, timebase (ticks por frame),
   *   srcClips: [{ id, name, start, end, inPoint, outPoint, speed, reversed, mediaEnd }] (ticks; mediaEnd pode ser null)
   *   dstClips: [{ id, name, start, end }]
   * }
   * @returns {{ ok: boolean, error?: string, ops: [], summary: {} }}
   */
  function plan(input) {
    const { srcTrack, dstTrack, type, frames, timebase } = input;
    if (srcTrack === dstTrack) return { ok: false, error: "A faixa de origem e a de destino precisam ser diferentes." };
    const clips = input.srcClips.slice().sort((a, b) => a.start - b.start);
    if (clips.length < 2) return { ok: false, error: "A faixa de origem precisa ter pelo menos 2 clipes." };

    const want = Math.max(0, Math.round(frames)) * timebase;
    const wantJ = type === "J" || type === "both" ? want : 0;
    const wantL = type === "L" || type === "both" ? want : 0;
    const dst = input.dstClips.slice().sort((a, b) => a.start - b.start);

    // 1) Os clipes que vão mudar de faixa não podem cair em cima de nada
    const conflicts = [];
    clips.forEach((c, i) => {
      if (i % 2 === 0) return;
      const hit = dst.find((d) => c.start < d.end && d.start < c.end);
      if (hit) conflicts.push({ clip: c.name, occupant: hit.name, start: c.start, end: c.end });
    });
    if (conflicts.length) {
      return {
        ok: false,
        error: `A faixa de destino já tem clipes onde o áudio precisa entrar (${conflicts.length} conflito(s)). Escolha uma faixa vazia nesse trecho.`,
        conflicts,
      };
    }

    // 2) Extensões pedidas por borda: J no início do clipe i (i>0), L no fim do clipe i (i<n-1)
    const n = clips.length;
    const J = new Array(n).fill(0);
    const L = new Array(n).fill(0);
    const notes = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
      const c = clips[i];
      const editable = (c.speed == null || Math.abs(c.speed - 1) < 1e-6) && !c.reversed;
      if (!editable) {
        notes[i] = "velocidade alterada";
        continue;
      }
      if (i > 0 && wantJ) {
        const handle = Math.max(0, c.inPoint); // não dá para começar antes do início da mídia
        J[i] = Math.min(wantJ, floorToFrame(handle, timebase));
      }
      if (i < n - 1 && wantL) {
        const handle = c.mediaEnd == null ? 0 : Math.max(0, c.mediaEnd - c.outPoint);
        L[i] = Math.min(wantL, floorToFrame(handle, timebase));
      }
    }

    // 3) Espaço na mesma faixa: o clipe k e o k+2 ficam na mesma faixa
    for (let k = 0; k + 2 < n; k++) {
      const gap = clips[k + 2].start - clips[k].end;
      const need = L[k] + J[k + 2];
      if (need > gap) {
        const room = Math.max(0, floorToFrame(gap, timebase));
        const half = floorToFrame(Math.floor(room / 2), timebase);
        let l = Math.min(L[k], half);
        let j = Math.min(J[k + 2], room - l);
        l = Math.min(L[k], room - j);
        L[k] = l;
        J[k + 2] = j;
      }
    }

    // 4) Espaço na faixa de destino, contra clipes que já estavam lá
    for (let i = 1; i < n; i += 2) {
      const c = clips[i];
      const before = dst.filter((d) => d.end <= c.start).pop();
      const after = dst.find((d) => d.start >= c.end);
      if (before) J[i] = Math.min(J[i], floorToFrame(Math.max(0, c.start - before.end), timebase));
      if (after) L[i] = Math.min(L[i], floorToFrame(Math.max(0, after.start - c.end), timebase));
    }

    // 5) Monta as operações e o resumo
    const ops = clips.map((c, i) => ({
      id: c.id,
      name: c.name,
      fromTrack: srcTrack,
      toTrack: i % 2 === 1 ? dstTrack : srcTrack,
      move: i % 2 === 1,
      extendStart: J[i],
      extendEnd: L[i],
      original: { start: c.start, end: c.end, inPoint: c.inPoint, outPoint: c.outPoint },
      note: notes[i],
    }));

    let requested = 0;
    let full = 0;
    let partial = 0;
    let none = 0;
    const partialList = [];
    for (let i = 0; i < n - 1; i++) {
      // cada ponto de edição entre o clipe i e o i+1
      const reqHere = wantL + wantJ;
      const gotHere = L[i] + J[i + 1];
      requested++;
      if (gotHere >= reqHere) full++;
      else if (gotHere > 0) {
        partial++;
        partialList.push({ at: clips[i + 1].start, gotFrames: Math.round(gotHere / timebase), wantFrames: Math.round(reqHere / timebase) });
      } else {
        none++;
        partialList.push({ at: clips[i + 1].start, gotFrames: 0, wantFrames: Math.round(reqHere / timebase) });
      }
    }

    return {
      ok: true,
      ops,
      summary: {
        clips: n,
        moved: ops.filter((o) => o.move).length,
        editPoints: requested,
        full,
        partial,
        none,
        partialList,
        skippedSpeed: notes.filter(Boolean).length,
      },
    };
  }

  function floorToFrame(ticks, timebase) {
    return Math.floor(ticks / timebase + 1e-9) * timebase;
  }

  return { TICKS_PER_SECOND, plan };
});
