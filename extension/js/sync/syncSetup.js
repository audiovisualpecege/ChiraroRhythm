/**
 * syncSetup.js — a ponte entre a timeline (resposta de host syncInfo) e o
 * motor de sincronia, sem interface (usado pelo painel e pelos testes):
 *
 *  - buildDevices: 1 faixa = 1 aparelho. Faixa de vídeo + o áudio vinculado
 *    forma um aparelho; clipes de áudio sem vídeo vinculado formam o aparelho
 *    da sua faixa de áudio.
 *  - buildItems: um item por clipe dos aparelhos marcados, na ordem da faixa,
 *    com o motivo quando não há áudio para analisar.
 *  - buildMoves: deslocamentos (ticks) para a cópia, em ordem segura, com a
 *    conferência de que nada vai se sobrepor.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncSetup = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const TPS = 254016000000;

  function buildDevices(si) {
    const linkedAudio = new Set();
    const devices = [];
    for (const vt of si.video) {
      if (!vt.clips.length) continue;
      const hasVideo = vt.clips.some((c) => c.kind === "video" || c.kind === "nested");
      for (const c of vt.clips) for (const [t, i] of c.linked) linkedAudio.add(t + ":" + i);
      const audioTracks = [...new Set(vt.clips.flatMap((c) => c.linked.map((l) => l[0])))].sort((x, y) => x - y);
      const lockedAudio = audioTracks.filter((t) => si.audio[t] && si.audio[t].locked);
      devices.push({
        id: "V" + (vt.index + 1),
        label: "V" + (vt.index + 1) + (audioTracks.length ? " + " + audioTracks.map((t) => "A" + (t + 1)).join(" + ") : ""),
        video: true,
        track: vt.index,
        clips: vt.clips.map((c, k) => ({ c, k })),
        audioTracks,
        locked: vt.locked || lockedAudio.length > 0,
        lockNote: vt.locked ? "faixa travada" : lockedAudio.length ? "áudio vinculado em faixa travada" : "",
        withAudio: vt.clips.filter((c) => c.linked.length).length,
        graphicsOnly: !hasVideo,
        seconds: vt.clips.reduce((s, c) => s + (c.end - c.start) / TPS, 0),
      });
    }
    for (const at of si.audio) {
      const free = at.clips.map((c, k) => ({ c, k })).filter((x) => !linkedAudio.has(at.index + ":" + x.k));
      if (!free.length) continue;
      devices.push({
        id: "A" + (at.index + 1),
        label: "A" + (at.index + 1),
        video: false,
        track: at.index,
        clips: free,
        audioTracks: [at.index],
        locked: at.locked,
        lockNote: at.locked ? "faixa travada" : "",
        withAudio: free.length,
        graphicsOnly: false,
        seconds: free.reduce((s, x) => s + (x.c.end - x.c.start) / TPS, 0),
      });
    }
    return devices;
  }

  // com a sincronização por imagem ligada, faixa de vídeo sem áudio também entra
  const usable = (d, visual) => !d.locked && !d.graphicsOnly && (d.withAudio > 0 || (!!visual && d.video));

  /**
   * @param devices saída de buildDevices
   * @param unchecked Set de ids de aparelhos desmarcados
   * @param normPath fn(caminho) -> caminho normalizado
   * @param visual sincronização por imagem ligada
   */
  function buildItems(devices, unchecked, normPath, visual) {
    const items = [];
    for (const d of devices) {
      if (!usable(d, visual) || unchecked.has(d.id)) continue;
      const sorted = d.clips.slice().sort((x, y) => x.c.start - y.c.start);
      sorted.forEach(({ c, k }, index) => {
        let noAudio = "";
        if (d.video) {
          if (c.kind !== "video" && c.kind !== "nested") noAudio = c.kind === "image" ? "imagem (sem áudio)" : "gráfico (sem áudio)";
          else if (c.kind === "nested") noAudio = "sequência aninhada (não lida)";
          else if (!c.linked.length) noAudio = "sem áudio vinculado";
        }
        if (!noAudio && c.speed && Math.abs(c.speed - 1) > 1e-6) noAudio = "velocidade alterada";
        if (!noAudio && c.reversed) noAudio = "invertido";
        if (!noAudio && !c.path) noAudio = "sem arquivo de mídia";
        const id = d.id + ":" + k;
        items.push({
          id, track: d.id, index, name: c.name,
          path: noAudio ? "#" + id : normPath(c.path),
          mediaPath: normPath(c.path || ""),
          start: c.start / TPS, end: c.end / TPS, inPoint: c.inPoint / TPS,
          startTicks: c.start,
          noAudio,
          phys: d.video ? { v: 1, t: d.track, i: k, audio: c.linked } : { v: 0, t: d.track, i: k, audio: [] },
        });
      });
    }
    return items;
  }

  /**
   * Movimentos (ticks) na cópia. Em cada faixa: quem vai para a esquerda em
   * ordem crescente, quem vai para a direita em ordem decrescente — assim um
   * clipe nunca passa por cima de outro no caminho. Lança erro (e nada é feito)
   * se a posição final sobrepuser clipes em alguma faixa.
   */
  function buildMoves(items, placed, si) {
    const tb = si.timebase;
    const fps = TPS / tb;
    const perTrack = new Map();
    const push = (v, t, i, d, from, len) => {
      const k = v + "|" + t;
      if (!perTrack.has(k)) perTrack.set(k, []);
      perTrack.get(k).push({ v, t, i, d, to: from + d, len });
    };
    items.forEach((it, n) => {
      const finalTicks = Math.round(placed[n].start * fps) * tb;
      const d = finalTicks - it.startTicks;
      const src = it.phys.v ? si.video[it.phys.t].clips[it.phys.i] : si.audio[it.phys.t].clips[it.phys.i];
      push(it.phys.v, it.phys.t, it.phys.i, d, src.start, src.end - src.start);
      for (const [t, i] of it.phys.audio) {
        const a = si.audio[t].clips[i];
        push(0, t, i, d, a.start, a.end - a.start);
      }
    });
    for (const [k, list] of perTrack) {
      const [v, t] = k.split("|").map(Number);
      const moved = new Set(list.map((m) => m.i));
      const all = list.map((m) => ({ s: m.to, e: m.to + m.len }));
      const src = v ? si.video[t].clips : si.audio[t].clips;
      src.forEach((c, i) => { if (!moved.has(i)) all.push({ s: c.start, e: c.end }); });
      all.sort((x, y) => x.s - y.s);
      for (let j = 1; j < all.length; j++) {
        if (all[j].s < all[j - 1].e - tb / 2) {
          throw new Error(`Na faixa ${v ? "V" : "A"}${t + 1} dois clipes ficariam sobrepostos — nada foi alterado. Desmarque essa faixa ou mande o clipe para órfão.`);
        }
      }
    }
    // Ordem preferida: clipe a clipe, o vídeo seguido do áudio vinculado — se o
    // processo parar no meio, nenhum áudio fica separado do seu vídeo. Vale
    // quando cada faixa de áudio pertence a um só aparelho e acompanha a ordem
    // do vídeo; senão, ordem faixa a faixa (também segura, mas sem esse cuidado).
    const audioOwner = new Map();
    let byItem = true;
    for (const it of items) {
      for (const [t] of it.phys.audio) {
        const owner = audioOwner.get(t);
        if (owner != null && owner !== it.track) byItem = false;
        audioOwner.set(t, it.track);
      }
      if (!it.phys.v && audioOwner.has(it.phys.t) && audioOwner.get(it.phys.t) !== it.track) byItem = false;
    }
    if (byItem) {
      // em cada aparelho o áudio vinculado precisa seguir a ordem do vídeo
      const perDev = new Map();
      items.forEach((it) => { if (!perDev.has(it.track)) perDev.set(it.track, []); perDev.get(it.track).push(it); });
      for (const list of perDev.values()) {
        list.sort((x, y) => x.phys.i - y.phys.i);
        const last = new Map();
        for (const it of list) for (const [t, i] of it.phys.audio) {
          if (last.has(t) && i <= last.get(t)) byItem = false;
          last.set(t, i);
        }
      }
    }
    // destino absoluto: o host calcula o deslocamento na hora (repetir é seguro)
    const out = [];
    if (byItem) {
      const perDev = new Map();
      items.forEach((it, n) => {
        const fin = Math.round(placed[n].start * fps) * tb;
        const src = it.phys.v ? si.video[it.phys.t].clips[it.phys.i] : si.audio[it.phys.t].clips[it.phys.i];
        const d = fin - src.start;
        if (!d) return;
        if (!perDev.has(it.track)) perDev.set(it.track, []);
        perDev.get(it.track).push({ it, d, fin });
      });
      for (const list of perDev.values()) {
        const left = list.filter((m) => m.d < 0).sort((x, y) => x.it.phys.i - y.it.phys.i);
        const right = list.filter((m) => m.d > 0).sort((x, y) => y.it.phys.i - x.it.phys.i);
        for (const m of left.concat(right)) {
          out.push({ v: m.it.phys.v, t: m.it.phys.t, i: m.it.phys.i, to: m.fin });
          for (const [t, i] of m.it.phys.audio) out.push({ v: 0, t, i, to: si.audio[t].clips[i].start + m.d });
        }
      }
      return out;
    }
    for (const list of perTrack.values()) {
      const left = list.filter((m) => m.d < 0).sort((x, y) => x.i - y.i);
      const right = list.filter((m) => m.d > 0).sort((x, y) => y.i - x.i);
      for (const m of left.concat(right)) out.push({ v: m.v, t: m.t, i: m.i, to: m.to });
    }
    return out;
  }

  return { buildDevices, buildItems, buildMoves, usable };
});
