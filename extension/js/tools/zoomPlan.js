/**
 * zoomPlan.js
 *
 * Lógica pura do Alternador de Zoom. Para cada clipe elegível de cada faixa
 * (em ordem, contando cada faixa separado) decide a escala e a posição do
 * Transformar:
 *
 *   ciclo = [100, principal] ou [100, principal, segunda]
 *   "começar com zoom" avança o ciclo uma posição
 *
 * Modo fixo: uma escala por clipe. Em movimento: keyframes lineares do
 * início ao fim do clipe, entre a escala do ciclo e ela + intensidade
 * (pontos percentuais). A posição mantém o ponto de mira (X/Y) parado na
 * tela: pos = mira·(1 − s) + 0,5·s  (coordenadas normalizadas, s = escala/100)
 * — assim nunca aparece borda com escala ≥ 100%.
 */
(function (root, factory) {
  const api = factory();
  root.AEZoomPlan = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function cycleOf(s) {
    const c = [100, s.mainScale];
    if (s.secondEnabled) c.push(s.secondScale);
    return c;
  }

  /** Posição (normalizada) que mantém o ponto de mira fixo na tela. */
  function positionFor(scalePct, focusX, focusY) {
    const s = scalePct / 100;
    return [focusX * (1 - s) + 0.5 * s, focusY * (1 - s) + 0.5 * s];
  }

  /**
   * @param tracks [{ track, clips: [{ id, start, ... }] }] só clipes elegíveis
   * @param s { mainScale, secondEnabled, secondScale, startWithZoom, focusX, focusY (0..1),
   *            mode: "fixed"|"moving", direction: "in"|"out"|"alternate", intensity (pontos %) }
   * @returns [{ id, track, index, scale, scaleStart, scaleEnd, posStart, posEnd, moving, needsEffect }]
   */
  function plan(tracks, s) {
    const cycle = cycleOf(s);
    const offset = s.startWithZoom ? 1 : 0;
    const out = [];
    for (const t of tracks) {
      const clips = t.clips.slice().sort((a, b) => a.start - b.start);
      clips.forEach((c, i) => {
        const base = cycle[(i + offset) % cycle.length];
        let s0 = base;
        let s1 = base;
        const moving = s.mode === "moving" && s.intensity > 0;
        if (moving) {
          const dir = s.direction === "alternate" ? (i % 2 === 0 ? "in" : "out") : s.direction;
          if (dir === "in") s1 = base + s.intensity;
          else s0 = base + s.intensity;
        }
        out.push({
          id: c.id,
          track: t.track,
          index: i,
          name: c.name,
          scale: base,
          scaleStart: s0,
          scaleEnd: s1,
          posStart: positionFor(s0, s.focusX, s.focusY),
          posEnd: positionFor(s1, s.focusX, s.focusY),
          moving,
          // 100% parado não precisa de efeito (e um zoom antigo do app é removido)
          needsEffect: moving || Math.abs(base - 100) > 1e-9,
        });
      });
    }
    return out;
  }

  function summarize(items) {
    const byScale = {};
    items.forEach((it) => (byScale[it.scale] = (byScale[it.scale] || 0) + 1));
    return { total: items.length, byScale };
  }

  return { cycleOf, positionFor, plan, summarize };
});
