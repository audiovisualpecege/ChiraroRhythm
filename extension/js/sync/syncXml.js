/**
 * syncXml.js — cria a cópia sincronizada por FCP XML (como o Syncalia), em vez
 * de mover clipe a clipe. Medido em 26.5.1 (07/10): trackItem.move() custa
 * ~100–140 ms cada, sem depender da distância, e trava por minutos de vez em
 * quando (2.362 movimentos = 5 a 26+ min). Exportar o XML (~3 s), reescrever
 * aqui (~0,1 s) e importar (~6 s) dá o mesmo resultado, conferido clipe a
 * clipe (posição, aparo, arquivo, vínculos).
 *
 *  - rewrite(xml, si, moves, opts): troca <start>/<end> dos clipitems da
 *    sequência pelos destinos de `moves` (mesmo formato de api.syncMove:
 *    { v, t, i, to } com `to` em ticks), além de <uuid>, <name> e <duration>.
 *    Confere antes que cada clipitem bate com o clipe de `si` (resposta de
 *    syncInfo) na mesma faixa/posição; qualquer diferença lança erro — quem
 *    chama volta para o caminho dos movimentos.
 *
 * O áudio vem "explodido": uma faixa estéreo do Premiere vira 2 faixas no XML
 * (currentExplodedTrackIndex 0 e 1) com os mesmos clipes. Faixa nova do
 * Premiere = currentExplodedTrackIndex ausente ou "0".
 */
(function (root, factory) {
  const api = factory();
  root.AESyncXml = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const TPS = 254016000000;
  const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>/g;

  /** Ticks por quadro do <rate> (timebase inteiro + ntsc). */
  function ticksPerFrame(timebase, ntsc) {
    return ntsc ? (TPS * 1001) / (timebase * 1000) : TPS / timebase;
  }

  /**
   * Percorre as tags guardando o caminho. Devolve a 1ª <sequence> de nível
   * superior com suas faixas e, em cada uma, os clipitems diretos com a posição
   * do texto de <start> e <end> (filhos diretos do clipitem).
   */
  function scan(xml) {
    const stack = [];
    const seq = { start: -1, end: -1, uuid: null, name: null, duration: null, rate: null, video: [], audio: [] };
    let track = null;
    let clip = null;
    let rate = null;
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(xml))) {
      if (!m[2]) continue; // comentário, <?xml?>, DOCTYPE, CDATA
      const closing = m[1] === "/";
      const selfClosing = m[4] === "/";
      const name = m[2];
      if (closing) {
        const top = stack.pop();
        if (!top || top.name !== name) throw new Error(`XML malformado perto de </${name}>`);
        const path = stack.map((s) => s.name).join("/");
        const inner = { from: top.end, to: m.index };
        if (name === "sequence" && path === "xmeml") { seq.end = m.index; break; }
        if (path === "xmeml/sequence") {
          if (name === "uuid") seq.uuid = inner;
          else if (name === "name") seq.name = inner;
          else if (name === "duration") seq.duration = inner;
        }
        if (path === "xmeml/sequence/rate" && rate) {
          if (name === "timebase") rate.timebase = Number(xml.slice(inner.from, inner.to));
          else if (name === "ntsc") rate.ntsc = xml.slice(inner.from, inner.to).trim().toUpperCase() === "TRUE";
        }
        if (name === "rate" && path === "xmeml/sequence") seq.rate = rate;
        if (clip && path === clip.path) {
          if (name === "start") clip.start = inner;
          else if (name === "end") clip.end = inner;
        }
        if (name === "clipitem" && clip && path + "/clipitem" === clip.path) { track.clips.push(clip); clip = null; }
        if (name === "track" && track && /^xmeml\/sequence\/media\/(video|audio)$/.test(path)) track = null;
        continue;
      }
      const path = stack.map((s) => s.name).join("/");
      if (name === "sequence" && path === "xmeml") seq.start = m.index;
      if (name === "rate" && path === "xmeml/sequence") rate = { timebase: null, ntsc: false };
      if (name === "track" && /^xmeml\/sequence\/media\/(video|audio)$/.test(path)) {
        const kind = path.endsWith("video") ? "video" : "audio";
        const ex = /\bcurrentExplodedTrackIndex="(\d+)"/.exec(m[3]);
        track = { kind, exploded: ex ? Number(ex[1]) : 0, clips: [] };
        seq[kind].push(track);
      }
      if (name === "clipitem" && track && /^xmeml\/sequence\/media\/(video|audio)\/track$/.test(path)) {
        clip = { path: path + "/clipitem", start: null, end: null };
      }
      if (!selfClosing) stack.push({ name, end: m.index + m[0].length });
    }
    if (seq.start < 0 || seq.end < 0) throw new Error("O XML não tem uma sequência.");
    if (!seq.rate || !seq.rate.timebase) throw new Error("O XML não informa a taxa de quadros da sequência.");
    return seq;
  }

  /** Agrupa as faixas de áudio explodidas por faixa do Premiere. */
  function premiereAudioTracks(xmlTracks) {
    const out = [];
    for (const t of xmlTracks) {
      if (t.exploded === 0 || !out.length) out.push([t]);
      else out[out.length - 1].push(t);
    }
    return out;
  }

  function newUuid() {
    const c = typeof crypto !== "undefined" ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /**
   * @param {string} xml  FCP XML exportado pelo Premiere (exportAsFinalCutProXML)
   * @param {object} si   resposta de syncInfo da sequência ORIGINAL
   * @param {Array}  moves [{ v, t, i, to }] (to em ticks, início final)
   * @param {object} opts { name, uuid? }
   * @returns {{ xml: string, changed: number, frames: number }}
   */
  function rewrite(xml, si, moves, opts) {
    const seq = scan(xml);
    // Sequência criada a partir de clipe com taxa "quase 29,97" (ex.: 8475726470 ticks/quadro,
    // medido 13/10) sai no XML como 30 NTSC exato: mesma taxa nominal → conta quadros na grade da sequência.
    const xmlTpf = ticksPerFrame(seq.rate.timebase, seq.rate.ntsc);
    if (Math.abs(xmlTpf - si.timebase) / si.timebase > 1e-4) throw new Error(`Taxa do XML (${seq.rate.timebase}${seq.rate.ntsc ? " NTSC" : ""}) diferente da sequência.`);
    const tpf = si.timebase;
    const drift = Math.abs(xmlTpf - tpf) / tpf; // 0 nas taxas exatas
    const toFrame = (ticks, what) => {
      const f = ticks / tpf;
      const r = Math.round(f);
      if (Math.abs(f - r) > 1e-3) throw new Error(`${what} fora do quadro inteiro.`);
      return r;
    };

    const tracks = { video: seq.video.map((t) => [t]), audio: premiereAudioTracks(seq.audio) };
    const regrid = new Map(); // clipitem -> [ci, início, fim] na grade da sequência (só com taxa "quase igual")
    for (const kind of ["video", "audio"]) {
      if (tracks[kind].length !== si[kind].length) throw new Error(`O XML tem ${tracks[kind].length} faixa(s) de ${kind === "video" ? "vídeo" : "áudio"}; a sequência tem ${si[kind].length}.`);
      si[kind].forEach((st, t) => {
        for (const xt of tracks[kind][t]) {
          if (xt.clips.length !== st.clips.length) throw new Error(`${kind === "video" ? "V" : "A"}${t + 1}: ${xt.clips.length} clipe(s) no XML, ${st.clips.length} na sequência.`);
          st.clips.forEach((c, i) => {
            const xs = Number(xml.slice(xt.clips[i].start.from, xt.clips[i].start.to));
            const exp = toFrame(c.start, "Clipe");
            // taxa "quase igual": o Premiere exporta em segundos → quadros de 30 NTSC; a diferença
            // acumula (7 ppm ≈ 1 quadro a cada ~1h30). Só a conferência tolera isso; as posições
            // escritas continuam em quadros inteiros da sequência (distâncias entre clipes exatas).
            const tolF = drift ? Math.ceil(drift * exp) + 1 : 0;
            if (Math.abs(xs - exp) > tolF) throw new Error(`${kind === "video" ? "V" : "A"}${t + 1} clipe ${i + 1}: o XML não bate com a sequência.`);
            // todos na mesma grade (a da sequência), mesmo os que não se movem
            if (xs !== exp) {
              const e = Number(xml.slice(xt.clips[i].end.from, xt.clips[i].end.to));
              regrid.set(xt.clips[i].start.from, [xt.clips[i], exp, exp + (e - xs)]);
            }
          });
        }
      });
    }

    // edições: [posição inicial, final, texto novo], aplicadas de trás para frente
    const edits = [];
    let changed = 0;
    for (const mv of moves) {
      const kind = mv.v ? "video" : "audio";
      const group = tracks[kind][mv.t];
      const c = si[kind][mv.t] && si[kind][mv.t].clips[mv.i];
      if (!group || !c) throw new Error(`Movimento para um clipe que não existe (${mv.v ? "V" : "A"}${mv.t + 1} #${mv.i + 1}).`);
      const from = toFrame(c.start, "Clipe");
      const to = toFrame(Math.round(mv.to), "Destino");
      if (to === from) continue;
      for (const xt of group) {
        const ci = xt.clips[mv.i];
        const s = Number(xml.slice(ci.start.from, ci.start.to));
        const e = Number(xml.slice(ci.end.from, ci.end.to));
        regrid.delete(ci.start.from);
        edits.push([ci.start.from, ci.start.to, String(to)]);
        edits.push([ci.end.from, ci.end.to, String(to + (e - s))]);
      }
      changed++;
    }
    for (const [ci, s, e] of regrid.values()) {
      edits.push([ci.start.from, ci.start.to, String(s)]);
      edits.push([ci.end.from, ci.end.to, String(e)]);
    }

    // duração da sequência = maior fim depois das mudanças
    const newEnd = new Map(edits.filter((_, k) => k % 2 === 1).map((e) => [e[0], Number(e[2])]));
    let frames = 0;
    for (const kind of ["video", "audio"]) {
      for (const g of tracks[kind]) for (const xt of g) for (const ci of xt.clips) {
        const e = newEnd.has(ci.end.from) ? newEnd.get(ci.end.from) : Number(xml.slice(ci.end.from, ci.end.to));
        if (e > frames) frames = e;
      }
    }
    if (seq.uuid) edits.push([seq.uuid.from, seq.uuid.to, opts.uuid || newUuid()]);
    if (seq.name) edits.push([seq.name.from, seq.name.to, escapeXml(opts.name)]);
    if (seq.duration) edits.push([seq.duration.from, seq.duration.to, String(frames)]);

    edits.sort((a, b) => a[0] - b[0]);
    const parts = [];
    let pos = 0;
    for (const [a, b, text] of edits) {
      parts.push(xml.slice(pos, a), text);
      pos = b;
    }
    parts.push(xml.slice(pos));
    return { xml: parts.join(""), changed, frames };
  }

  return { rewrite, scan, ticksPerFrame };
});
