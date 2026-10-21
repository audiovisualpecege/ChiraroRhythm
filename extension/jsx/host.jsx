/**
 * host.jsx — roda DENTRO do Premiere (motor ExtendScript, ES3).
 *
 * Tudo fica dentro do objeto global AutomacaoEdicao para não colidir com
 * outras extensões (no Premiere todas dividem o mesmo motor ExtendScript).
 * O painel chama:  AutomacaoEdicao.call("nomeDaFuncao", "<json dos argumentos>")
 * e recebe uma string JSON  { ok: true, data } | { ok: false, error }.
 *
 * Métodos validados no Premiere 26.5 (out/2026):
 *   QE  sequence.extract(tcIn, tcOut)    -> ripple delete do intervalo em
 *                                           todas as faixas destravadas
 *   QE  trackItem.moveToTrack(dV, dA, tcOffset, false) -> move de faixa
 *                                           mantendo id, in/out e efeitos
 *   DOM trackItem.start/end/inPoint/outPoint (setters) -> J/L sem mexer no vídeo
 *   DOM sequence.clone(), markers, setPlayerPosition(ticks)
 */

var AutomacaoEdicao = (function () {
  var TICKS_PER_SECOND = 254016000000;

  // ---------------------------------------------------------------- JSON
  function toJSON(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return String(v);
    if (t === "string") return quote(v);
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(toJSON(v[i]));
      return "[" + a.join(",") + "]";
    }
    if (t === "object") {
      var kv = [];
      for (var k in v) {
        if (!v.hasOwnProperty(k)) continue;
        kv.push(quote(k) + ":" + toJSON(v[k]));
      }
      return "{" + kv.join(",") + "}";
    }
    return "null";
  }

  function quote(s) {
    s = String(s);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"' || c === "\\") out += "\\" + c;
      else if (code === 10) out += "\\n";
      else if (code === 13) out += "\\r";
      else if (code === 9) out += "\\t";
      else if (code < 32 || code === 0x2028 || code === 0x2029) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  }

  /** Só recebe JSON gerado pelo próprio painel. */
  function fromJSON(s) {
    return eval("(" + s + ")");
  }

  // -------------------------------------------------------------- helpers
  function activeSeq(expectedId) {
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) throw new Error("Nenhuma sequência aberta na Timeline.");
    if (expectedId && seq.sequenceID !== expectedId) {
      throw new Error("A sequência ativa mudou desde a análise. Volte para \"" + seqNameById(expectedId) + "\" ou analise de novo.");
    }
    return seq;
  }

  function seqNameById(id) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      if (app.project.sequences[i].sequenceID === id) return app.project.sequences[i].name;
    }
    return "?";
  }

  function qeSeqFor(seq) {
    app.enableQE();
    var q = qe.project.getActiveSequence();
    if (!q) throw new Error("O Premiere não liberou a sequência para edição (QE).");
    return q;
  }

  function timeFromTicks(ticks) {
    var t = new Time();
    t.ticks = String(Math.round(Number(ticks)));
    return t;
  }

  function timecodeOf(seq, ticks) {
    var st = seq.getSettings();
    return timeFromTicks(ticks).getFormatted(st.videoFrameRate, st.videoDisplayFormat);
  }

  function ticksOf(time) {
    return Number(time.ticks);
  }

  function findClip(seq, id) {
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var tr = seq.audioTracks[t];
      for (var c = 0; c < tr.clips.numItems; c++) {
        if (tr.clips[c].nodeId === id) return { clip: tr.clips[c], track: t };
      }
    }
    return null;
  }

  function qeItemFor(qeTrack, domClip) {
    var st = String(domClip.start.ticks);
    var en = String(domClip.end.ticks);
    for (var i = 0; i < qeTrack.numItems; i++) {
      var it = qeTrack.getItemAt(i);
      if (!it || String(it.type) === "Empty") continue;
      if (String(it.start.ticks) === st && String(it.end.ticks) === en) return it;
    }
    return null;
  }

  function itemIdOf(clip) {
    try { return clip.projectItem ? String(clip.projectItem.nodeId) : ""; } catch (e) { return ""; }
  }

  function mediaPathOf(clip) {
    try {
      if (clip.projectItem && clip.projectItem.getMediaPath) return String(clip.projectItem.getMediaPath());
    } catch (e) {}
    return "";
  }

  /** Fim da mídia em ticks (sem considerar marcas do Source Monitor além do clipe). */
  function mediaEndTicks(clip) {
    var best = ticksOf(clip.outPoint);
    try {
      var pi = clip.projectItem;
      var types = [1, 2, 4];
      for (var i = 0; i < types.length; i++) {
        try {
          var o = pi.getOutPoint(types[i]);
          if (o && Number(o.ticks) > best) best = Number(o.ticks);
        } catch (e1) {}
      }
    } catch (e) {}
    return best;
  }

  function clipInfo(clip, trackIndex) {
    var speed = 1;
    var reversed = false;
    try { speed = clip.getSpeed(); } catch (e1) {}
    try { reversed = clip.isSpeedReversed() ? true : false; } catch (e2) {}
    var selected = false;
    try { selected = clip.isSelected() ? true : false; } catch (e3) {}
    return {
      id: clip.nodeId,
      name: clip.name,
      track: trackIndex,
      start: ticksOf(clip.start),
      end: ticksOf(clip.end),
      inPoint: ticksOf(clip.inPoint),
      outPoint: ticksOf(clip.outPoint),
      speed: speed,
      reversed: reversed,
      disabled: clip.disabled ? true : false,
      selected: selected,
      path: mediaPathOf(clip),
    };
  }

  // ------------------------------------------------------------ leitura
  var api = {};

  api.info = function () {
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) return { sequence: null, project: app.project ? app.project.name : null };
    var audio = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var tr = seq.audioTracks[t];
      var selected = 0;
      for (var c = 0; c < tr.clips.numItems; c++) {
        try { if (tr.clips[c].isSelected()) selected++; } catch (e) {}
      }
      audio.push({
        index: t,
        name: tr.name || "A" + (t + 1),
        locked: tr.isLocked() ? true : false,
        muted: tr.isMuted() ? true : false,
        clips: tr.clips.numItems,
        selected: selected,
      });
    }
    var lockedVideo = 0;
    var video = [];
    var selectedVideo = null;
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var vt = seq.videoTracks[v];
      if (vt.isLocked()) lockedVideo++;
      var vSel = 0;
      for (var vc = 0; vc < vt.clips.numItems; vc++) {
        var vclip = vt.clips[vc];
        var isSel = false;
        try { isSel = vclip.isSelected() ? true : false; } catch (eS) {}
        if (isSel) {
          vSel++;
          if (!selectedVideo) selectedVideo = { id: vclip.nodeId, track: v, name: vclip.name };
        }
      }
      video.push({ index: v, name: vt.name || "V" + (v + 1), locked: vt.isLocked() ? true : false, clips: vt.clips.numItems, selected: vSel });
    }
    return {
      project: app.project.name,
      sequence: {
        id: seq.sequenceID,
        name: seq.name,
        timebase: Number(seq.timebase),
        fps: TICKS_PER_SECOND / Number(seq.timebase),
        end: Number(seq.end),
        playhead: Number(seq.getPlayerPosition().ticks),
        videoTracks: seq.videoTracks.numTracks,
        lockedVideoTracks: lockedVideo,
      },
      audioTracks: audio,
      videoTracksInfo: video,
      selectedVideo: selectedVideo,
    };
  };

  /** args: { seqId, tracks: [índices], selectedOnly: bool } */
  api.audioClips = function (args) {
    var seq = activeSeq(args.seqId);
    var out = [];
    for (var i = 0; i < args.tracks.length; i++) {
      var t = args.tracks[i];
      var tr = seq.audioTracks[t];
      if (!tr) continue;
      for (var c = 0; c < tr.clips.numItems; c++) {
        var clip = tr.clips[c];
        var info = clipInfo(clip, t);
        if (args.selectedOnly && !info.selected) continue;
        out.push(info);
      }
    }
    return { clips: out };
  };

  api.playhead = function () {
    var seq = app.project.activeSequence;
    if (!seq) return { ticks: null };
    return { ticks: Number(seq.getPlayerPosition().ticks), seqId: seq.sequenceID };
  };

  /** args: { seqId, ticks } */
  api.seek = function (args) {
    var seq = activeSeq(args.seqId);
    seq.setPlayerPosition(String(Math.round(args.ticks)));
    return { ticks: Number(seq.getPlayerPosition().ticks) };
  };

  // ------------------------------------------------- Cortador de Silêncios
  /** Marcadores de intervalo em cada corte (rede de segurança). args: { seqId, cuts: [{ start, end, label }] em ticks } */
  api.markCuts = function (args) {
    var seq = activeSeq(args.seqId);
    var guids = [];
    for (var i = 0; i < args.cuts.length; i++) {
      var c = args.cuts[i];
      var m = seq.markers.createMarker(c.start / TICKS_PER_SECOND);
      m.end = c.end / TICKS_PER_SECOND;
      m.name = c.label;
      m.comments = "Silêncio detectado pelo Rhythm. Se o corte automático não aconteceu, corte este intervalo manualmente.";
      try { m.setColorByIndex(1); } catch (e) {} // vermelho
      guids.push(m.guid);
    }
    return { guids: guids };
  };

  function findMarker(seq, guid) {
    var m = seq.markers.getFirstMarker();
    while (m) {
      if (m.guid === guid) return m;
      m = seq.markers.getNextMarker(m);
    }
    return null;
  }

  /** Duplica a sequência ativa (o backup fica no mesmo bin). */
  api.backup = function (args) {
    var seq = activeSeq(args.seqId);
    var before = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) before[app.project.sequences[i].sequenceID] = true;
    if (!seq.clone()) throw new Error("O Premiere não conseguiu duplicar a sequência.");
    var copy = null;
    for (var j = 0; j < app.project.sequences.numSequences; j++) {
      var s = app.project.sequences[j];
      if (!before[s.sequenceID]) copy = s;
    }
    if (!copy) throw new Error("Backup criado, mas não encontrei a cópia para renomear.");
    copy.name = args.name;
    if (app.project.activeSequence.sequenceID !== seq.sequenceID) app.project.openSequence(seq.sequenceID);
    return { name: copy.name, id: copy.sequenceID };
  };

  /**
   * Ripple delete de cada intervalo. Os cortes DEVEM vir do fim para o
   * começo, assim um corte não desloca os próximos.
   * args: { seqId, cuts: [{ start, end, guid, doneLabel }] em ticks }
   */
  api.extractCuts = function (args) {
    var seq = activeSeq(args.seqId);
    var q = qeSeqFor(seq);
    var results = [];
    for (var i = 0; i < args.cuts.length; i++) {
      var c = args.cuts[i];
      var r = { start: c.start, ok: false };
      try {
        var endBefore = Number(seq.end);
        var ok = q.extract(timecodeOf(seq, c.start), timecodeOf(seq, c.end));
        r.ok = ok ? true : false;
        if (r.ok && Number(seq.end) >= endBefore) {
          // O extract respondeu "ok" mas nada saiu (ex.: todas as faixas travadas nesse trecho)
          r.ok = false;
          r.error = "Nada foi removido (faixas travadas?)";
        }
        if (!ok) r.error = "O Premiere recusou o corte.";
      } catch (e) {
        r.error = String(e);
      }
      if (r.ok) {
        // O extract apaga junto os marcadores que estavam dentro do trecho
        // removido (inclusive o de segurança). Deixa um marcador de ponto
        // no local da edição; marcadores de cortes que falharam continuam
        // como intervalo para corte manual.
        try {
          var m = c.guid ? findMarker(seq, c.guid) : null;
          if (!m) m = seq.markers.createMarker(c.start / TICKS_PER_SECOND);
          m.end = m.start.seconds;
          m.name = c.doneLabel;
          m.comments = "Silêncio removido aqui pelo Rhythm.";
          try { m.setColorByIndex(4); } catch (e2) {}
        } catch (e3) {}
      }
      results.push(r);
    }
    return { results: results };
  };

  // --------------------------------------------------- Áudio Intercalado
  /** args: { seqId, srcTrack, dstTrack } */
  api.interleaveClips = function (args) {
    var seq = activeSeq(args.seqId);
    var src = seq.audioTracks[args.srcTrack];
    var dst = seq.audioTracks[args.dstTrack];
    if (!src || !dst) throw new Error("Faixa inexistente.");
    if (src.isLocked() || dst.isLocked()) throw new Error("Destrave as faixas de origem e destino.");
    var s = [];
    for (var i = 0; i < src.clips.numItems; i++) {
      var info = clipInfo(src.clips[i], args.srcTrack);
      info.mediaEnd = mediaEndTicks(src.clips[i]);
      s.push(info);
    }
    var d = [];
    for (var j = 0; j < dst.clips.numItems; j++) d.push(clipInfo(dst.clips[j], args.dstTrack));
    return { srcClips: s, dstClips: d, timebase: Number(seq.timebase) };
  };

  function moveToAudioTrack(seq, q, id, toTrack) {
    var f = findClip(seq, id);
    if (!f) throw new Error("clipe não encontrado");
    if (f.track === toTrack) return;
    var qeItem = qeItemFor(q.getAudioTrackAt(f.track), f.clip);
    if (!qeItem) throw new Error("clipe não encontrado no QE");
    var zero = timecodeOf(seq, 0);
    if (!qeItem.moveToTrack(0, toTrack - f.track, zero, false)) throw new Error("o Premiere recusou mover o clipe");
    var after = findClip(seq, id);
    if (!after || after.track !== toTrack) throw new Error("o clipe não chegou na faixa de destino");
  }

  /** Estende (delta > 0) ou encolhe (delta < 0) as bordas do áudio sem mexer no vídeo. */
  function adjustEdges(seq, id, startDelta, endDelta) {
    var f = findClip(seq, id);
    if (!f) throw new Error("clipe não encontrado");
    var c = f.clip;
    if (startDelta) {
      c.start = timeFromTicks(ticksOf(c.start) - startDelta);
      c.inPoint = timeFromTicks(ticksOf(c.inPoint) - startDelta);
    }
    if (endDelta) {
      c.end = timeFromTicks(ticksOf(c.end) + endDelta);
      c.outPoint = timeFromTicks(ticksOf(c.outPoint) + endDelta);
    }
    f = findClip(seq, id);
    return { start: ticksOf(f.clip.start), end: ticksOf(f.clip.end), track: f.track };
  }

  /**
   * Aplica o plano: primeiro todos os movimentos de faixa, depois as
   * extensões (assim nenhuma extensão esbarra num clipe que ainda vai sair).
   * args: { seqId, ops: [{ id, move, toTrack, extendStart, extendEnd }] }
   */
  api.interleaveApply = function (args) {
    var seq = activeSeq(args.seqId);
    var q = qeSeqFor(seq);
    var res = {};
    var i, op;
    for (i = 0; i < args.ops.length; i++) {
      op = args.ops[i];
      res[op.id] = { id: op.id, moved: false, extendStart: 0, extendEnd: 0 };
      if (!op.move) continue;
      try {
        moveToAudioTrack(seq, q, op.id, op.toTrack);
        res[op.id].moved = true;
      } catch (e) {
        res[op.id].error = "mover: " + e;
      }
    }
    for (i = 0; i < args.ops.length; i++) {
      op = args.ops[i];
      if (res[op.id].error || (!op.extendStart && !op.extendEnd)) continue;
      try {
        var after = adjustEdges(seq, op.id, op.extendStart, op.extendEnd);
        res[op.id].extendStart = op.extendStart;
        res[op.id].extendEnd = op.extendEnd;
        res[op.id].after = after;
      } catch (e2) {
        res[op.id].error = "estender: " + e2;
      }
    }
    var list = [];
    for (i = 0; i < args.ops.length; i++) list.push(res[args.ops[i].id]);
    return { results: list };
  };

  /**
   * Desfaz só o que a ferramenta aplicou, em cima do estado ATUAL: encolhe
   * as bordas pelo mesmo tanto que esticou e devolve o clipe para a faixa
   * de origem. Funciona mesmo que o clipe tenha sido movido no tempo depois.
   * args: { seqId, ops: [{ id, moved, fromTrack, toTrack, extendStart, extendEnd }] }
   */
  api.interleaveUndo = function (args) {
    var seq = activeSeq(args.seqId);
    var q = qeSeqFor(seq);
    var out = [];
    var i, op, r;
    for (i = 0; i < args.ops.length; i++) {
      op = args.ops[i];
      r = { id: op.id, ok: true };
      out.push(r);
      if (!findClip(seq, op.id)) {
        r.ok = false;
        r.error = "clipe não existe mais na sequência";
        continue;
      }
      if (op.extendStart || op.extendEnd) {
        try { adjustEdges(seq, op.id, -op.extendStart, -op.extendEnd); } catch (e) { r.ok = false; r.error = "bordas: " + e; }
      }
    }
    for (i = 0; i < args.ops.length; i++) {
      op = args.ops[i];
      r = out[i];
      if (!r.ok || !op.moved) continue;
      var f = findClip(seq, op.id);
      if (!f) continue;
      if (f.track !== op.toTrack) {
        r.note = "o clipe já não estava na faixa de destino; deixei onde está";
        continue;
      }
      // Não sobrepõe nada na faixa de origem
      var src = seq.audioTracks[op.fromTrack];
      var s = ticksOf(f.clip.start), e = ticksOf(f.clip.end), busy = null;
      for (var k = 0; k < src.clips.numItems; k++) {
        var o = src.clips[k];
        if (ticksOf(o.start) < e && s < ticksOf(o.end)) { busy = o.name; break; }
      }
      if (busy) {
        r.ok = false;
        r.error = "a faixa de origem está ocupada por \"" + busy + "\"";
        continue;
      }
      try { moveToAudioTrack(seq, q, op.id, op.fromTrack); } catch (e3) { r.ok = false; r.error = "voltar de faixa: " + e3; }
    }
    return { results: out };
  };

  // ------------------------------------------------------ Alternador de Zoom
  // O zoom vai num efeito Transformar (matchName "AE.ADBE Geometry") por
  // clipe, "assinado" com um ângulo de inclinação específico. Inclinação
  // fica 0, então o ângulo não tem efeito visual — mas identifica o efeito
  // como do app mesmo depois de razor, copiar/colar ou em outro computador.
  var TRANSFORM_MATCH = "AE.ADBE Geometry";
  var ZOOM_SIGNATURE = 0.0137;
  var TRANSFORM_NAMES = ["Transform", "Transformar", "Transformer", "Transformieren", "Trasforma", "Transformación", "変形", "变换"];

  // Índices fixos das propriedades do Transformar (iguais em qualquer idioma)
  var TP = { anchor: 0, position: 1, uniform: 2, scaleH: 3, scaleW: 4, skew: 5, skewAxis: 6, rotation: 7, opacity: 8, useComp: 9, shutter: 10 };

  function isAppTransform(comp) {
    if (comp.matchName !== TRANSFORM_MATCH) return false;
    try {
      var axis = comp.properties[TP.skewAxis];
      if (axis.isTimeVarying()) return false;
      return Math.abs(Number(axis.getValue()) - ZOOM_SIGNATURE) < 1e-5;
    } catch (e) {
      return false;
    }
  }

  /** Índice (em clip.components) do Transformar do app, ou -1. */
  function appTransformIndex(clip) {
    for (var j = 0; j < clip.components.numItems; j++) if (isAppTransform(clip.components[j])) return j;
    return -1;
  }

  function findVideoClip(seq, id) {
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var tr = seq.videoTracks[t];
      for (var c = 0; c < tr.clips.numItems; c++) if (tr.clips[c].nodeId === id) return { clip: tr.clips[c], track: t };
    }
    return null;
  }

  function qeVideoItemFor(q, track, domClip) {
    return qeItemFor(q.getVideoTrackAt(track), domClip);
  }

  /** Classifica o clipe: "video" | "image" | "nested" | "graphic" | "adjustment" */
  var IMAGE_EXT = /\.(png|jpe?g|tiff?|psd|bmp|gif|webp|heic|exr|dpx|tga|ai|eps)$/i;
  function clipKind(clip) {
    try { if (clip.isMGT()) return "graphic"; } catch (e1) {}
    try { if (clip.isAdjustmentLayer()) return "adjustment"; } catch (e2) {}
    var pi = clip.projectItem;
    if (!pi) return "graphic";
    try { if (pi.isSequence()) return "nested"; } catch (e3) {}
    var path = "";
    try { path = String(pi.getMediaPath()); } catch (e4) {}
    if (!path) return "graphic"; // cor sólida, barras, títulos legados...
    return IMAGE_EXT.test(path) ? "image" : "video";
  }

  /**
   * Clipes de vídeo do escopo, por faixa, com o tipo de cada um.
   * args: { seqId, scope: "selected"|"track"|"all", track }
   */
  api.zoomClips = function (args) {
    var seq = activeSeq(args.seqId);
    var tracks = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      if (args.scope === "track" && t !== args.track) continue;
      var tr = seq.videoTracks[t];
      var list = [];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var clip = tr.clips[c];
        var sel = false;
        try { sel = clip.isSelected() ? true : false; } catch (e) {}
        if (args.scope === "selected" && !sel) continue;
        list.push({
          id: clip.nodeId,
          name: clip.name,
          start: ticksOf(clip.start),
          end: ticksOf(clip.end),
          kind: clipKind(clip),
          disabled: clip.disabled ? true : false,
          hasAppZoom: appTransformIndex(clip) >= 0,
        });
      }
      if (list.length) tracks.push({ track: t, name: tr.name || "V" + (t + 1), locked: tr.isLocked() ? true : false, clips: list });
    }
    return { tracks: tracks };
  };

  /** "Impressão digital" de um efeito, para achar qual foi inserido. */
  function fingerprint(comp) {
    var s = comp.matchName;
    for (var q = 0; q < comp.properties.numItems; q++) {
      var p = comp.properties[q];
      try { s += "|" + (p.isTimeVarying() ? "K" + p.getKeys().length : String(p.getValue())); } catch (e) { s += "|?"; }
    }
    return s;
  }

  function fingerprints(clip) {
    var a = [];
    for (var j = 0; j < clip.components.numItems; j++) a.push(fingerprint(clip.components[j]));
    return a;
  }

  function addAppTransform(seq, q, track, clip) {
    var qeItem = qeVideoItemFor(q, track, clip);
    if (!qeItem) throw new Error("clipe não encontrado no QE");
    // O Premiere insere o efeito novo no TOPO da pilha (antes dos que já
    // existem), não no fim. Compara a lista antes/depois para achar
    // exatamente o que entrou e nunca escrever num Transformar do usuário.
    var before = fingerprints(clip);
    var comp = null;
    for (var n = 0; n < TRANSFORM_NAMES.length && !comp; n++) {
      var fx = null;
      try { fx = qe.project.getVideoEffectByName(TRANSFORM_NAMES[n]); } catch (e) {}
      if (!fx) continue;
      qeItem.addVideoEffect(fx);
      var after = fingerprints(clip);
      if (after.length <= before.length) continue;
      var at = before.length;
      for (var k = 0; k < before.length; k++) {
        if (after[k] !== before[k]) { at = k; break; }
      }
      var candidate = clip.components[at];
      if (candidate.matchName === TRANSFORM_MATCH) comp = candidate;
      else {
        // efeito errado com o mesmo nome em outro idioma: desfaz
        try { qeItem.getComponentAt(at).remove(); } catch (e2) {}
        before = fingerprints(clip);
      }
    }
    if (!comp) throw new Error("efeito Transformar não encontrado neste Premiere");
    comp.properties[TP.uniform].setValue(true, true);
    comp.properties[TP.skew].setValue(0, true);
    comp.properties[TP.skewAxis].setValue(ZOOM_SIGNATURE, true);
    try { comp.properties[TP.useComp].setValue(false, true); } catch (e3) {}
    try { comp.properties[TP.shutter].setValue(0, true); } catch (e4) {}
    return comp;
  }

  function setAnimated(prop, inSec, outSec, v0, v1, moving) {
    prop.setTimeVarying(false); // limpa keyframes de uma aplicação anterior
    if (!moving) {
      prop.setValue(v0, true);
      return;
    }
    prop.setTimeVarying(true);
    prop.addKey(inSec);
    prop.setValueAtKey(inSec, v0, true);
    prop.addKey(outSec);
    prop.setValueAtKey(outSec, v1, true);
  }

  function writeZoom(clip, comp, it) {
    var a = clip.inPoint.seconds;
    var b = clip.outPoint.seconds;
    comp.properties[TP.uniform].setValue(true, true);
    setAnimated(comp.properties[TP.scaleH], a, b, it.scaleStart, it.scaleEnd, it.moving);
    setAnimated(comp.properties[TP.position], a, b, it.posStart, it.posEnd, it.moving);
  }

  function removeAppTransforms(seq, q, track, clip) {
    var removed = 0;
    for (var j = clip.components.numItems - 1; j >= 0; j--) {
      if (!isAppTransform(clip.components[j])) continue;
      var qeItem = qeVideoItemFor(q, track, clip);
      if (!qeItem) throw new Error("clipe não encontrado no QE");
      // Os componentes do QE vêm na mesma ordem do DOM
      var qc = qeItem.getComponentAt(j);
      if (String(qc.matchName) !== TRANSFORM_MATCH) throw new Error("ordem de efeitos inesperada");
      qc.remove();
      removed++;
    }
    return removed;
  }

  /**
   * Aplica/atualiza o zoom. args: { seqId, items: [{ id, needsEffect, moving, scaleStart, scaleEnd, posStart, posEnd }] }
   */
  api.zoomApply = function (args) {
    var seq = activeSeq(args.seqId);
    var q = qeSeqFor(seq);
    var results = [];
    for (var i = 0; i < args.items.length; i++) {
      var it = args.items[i];
      var r = { id: it.id, ok: true, action: "" };
      results.push(r);
      try {
        var f = findVideoClip(seq, it.id);
        if (!f) throw new Error("clipe não encontrado");
        var idx = appTransformIndex(f.clip);
        if (!it.needsEffect) {
          if (idx >= 0) {
            removeAppTransforms(seq, q, f.track, f.clip);
            r.action = "removido (100%)";
          } else r.action = "100%";
          continue;
        }
        var comp = idx >= 0 ? f.clip.components[idx] : addAppTransform(seq, q, f.track, f.clip);
        r.action = idx >= 0 ? "atualizado" : "aplicado";
        writeZoom(f.clip, comp, it);
      } catch (e) {
        r.ok = false;
        r.error = String(e.message || e);
      }
    }
    return { results: results };
  };

  /** Remove o zoom do app. args: { seqId, ids: [...] } */
  api.zoomRemove = function (args) {
    var seq = activeSeq(args.seqId);
    var q = qeSeqFor(seq);
    var removed = 0;
    var errors = [];
    for (var i = 0; i < args.ids.length; i++) {
      try {
        var f = findVideoClip(seq, args.ids[i]);
        if (f) removed += removeAppTransforms(seq, q, f.track, f.clip) ? 1 : 0;
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }
    return { removed: removed, errors: errors };
  };

  /**
   * Captura um frame do clipe para a prévia do painel, sem o zoom do app
   * (o Transformar do app é neutralizado durante a captura e restaurado).
   * args: { seqId, id, path (sem extensão) }
   */
  api.zoomCapture = function (args) {
    var seq = activeSeq(args.seqId);
    var q = qeSeqFor(seq);
    var f = findVideoClip(seq, args.id);
    if (!f) throw new Error("clipe não encontrado");
    var clip = f.clip;
    var start = ticksOf(clip.start);
    var end = ticksOf(clip.end);
    var ph = Number(seq.getPlayerPosition().ticks);
    var at = ph >= start && ph < end ? ph : Math.round(start + (end - start) / 3);

    var saved = null;
    var idx = appTransformIndex(clip);
    if (idx >= 0) {
      var comp = clip.components[idx];
      saved = [];
      var keyProps = [TP.position, TP.scaleH];
      for (var k = 0; k < keyProps.length; k++) {
        var p = comp.properties[keyProps[k]];
        var st = { i: keyProps[k], varying: p.isTimeVarying(), value: p.getValue(), keys: [] };
        if (st.varying) {
          var keys = p.getKeys();
          for (var n = 0; n < keys.length; n++) st.keys.push({ t: keys[n].seconds, v: p.getValueAtKey(keys[n]) });
        }
        saved.push(st);
        p.setTimeVarying(false);
        p.setValue(keyProps[k] === TP.position ? [0.5, 0.5] : 100, true);
      }
    }
    var ok = false;
    try {
      ok = q.exportFramePNG(timecodeOf(seq, at), args.path);
    } finally {
      if (saved) {
        var c2 = clip.components[idx];
        for (var s = 0; s < saved.length; s++) {
          var pr = c2.properties[saved[s].i];
          if (saved[s].varying) {
            pr.setTimeVarying(true);
            for (var kk = 0; kk < saved[s].keys.length; kk++) {
              pr.addKey(saved[s].keys[kk].t);
              pr.setValueAtKey(saved[s].keys[kk].t, saved[s].keys[kk].v, true);
            }
          } else pr.setValue(saved[s].value, true);
        }
      }
    }
    if (!ok) throw new Error("o Premiere não exportou o frame");
    var st2 = seq.getSettings();
    return { file: args.path + ".png", width: st2.videoFrameWidth, height: st2.videoFrameHeight, ticks: at, name: clip.name, track: f.track, kind: clipKind(clip) };
  };

  // ------------------------------------------------------------ Sincronizar
  function seqById(id) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      if (app.project.sequences[i].sequenceID === id) return app.project.sequences[i];
    }
    return null;
  }

  /**
   * Todos os clipes das faixas, para montar os "aparelhos" (1 faixa = 1 aparelho).
   * Vídeo: com os áudios vinculados (índices na faixa de áudio). Ticks em número.
   * args: { seqId }
   */
  api.syncInfo = function (args) {
    var seq = activeSeq(args.seqId);
    var audioPos = {}; // nodeId -> [faixa, índice]
    var audio = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var tr = seq.audioTracks[t];
      var list = [];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var a = tr.clips[c];
        audioPos[a.nodeId] = [t, c];
        list.push({ id: a.nodeId, name: a.name, start: ticksOf(a.start), end: ticksOf(a.end), inPoint: ticksOf(a.inPoint), path: mediaPathOf(a), item: itemIdOf(a), disabled: a.disabled ? true : false });
      }
      audio.push({ index: t, name: tr.name || "A" + (t + 1), locked: tr.isLocked() ? true : false, clips: list });
    }
    var video = [];
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var vt = seq.videoTracks[v];
      var vl = [];
      for (var k = 0; k < vt.clips.numItems; k++) {
        var clip = vt.clips[k];
        var linked = [];
        try {
          var L = clip.getLinkedItems();
          for (var j = 0; L && j < L.numItems; j++) {
            var p = audioPos[L[j].nodeId];
            if (p) linked.push(p);
          }
        } catch (eL) {}
        var speed = 1;
        try { speed = clip.getSpeed(); } catch (eS) {}
        var rev = false;
        try { rev = clip.isSpeedReversed() ? true : false; } catch (eR) {}
        vl.push({ id: clip.nodeId, name: clip.name, start: ticksOf(clip.start), end: ticksOf(clip.end), inPoint: ticksOf(clip.inPoint), path: mediaPathOf(clip), item: itemIdOf(clip), kind: clipKind(clip), linked: linked, speed: speed, reversed: rev });
      }
      video.push({ index: v, name: vt.name || "V" + (v + 1), locked: vt.isLocked() ? true : false, clips: vl });
    }
    return { seqId: seq.sequenceID, name: seq.name, timebase: Number(seq.timebase), video: video, audio: audio };
  };

  /** Duplica a sequência (a cópia é que será sincronizada). args: { seqId, name } */
  api.syncClone = function (args) {
    var seq = activeSeq(args.seqId);
    var before = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) before[app.project.sequences[i].sequenceID] = true;
    if (!seq.clone()) throw new Error("O Premiere não conseguiu duplicar a sequência.");
    var copy = null;
    for (var j = 0; j < app.project.sequences.numSequences; j++) {
      var s = app.project.sequences[j];
      if (!before[s.sequenceID]) copy = s;
    }
    if (!copy) throw new Error("A cópia foi criada, mas não a encontrei no projeto.");
    copy.name = args.name;
    return { id: copy.sequenceID, name: copy.name };
  };

  /**
   * Leva clipes da cópia até a posição final (DOM trackItem.move). Recebe o
   * destino ABSOLUTO e calcula o deslocamento na hora: repetir um lote (ex.:
   * depois de uma queda) não move nada de novo. O vídeo NÃO arrasta o áudio
   * vinculado: cada um vem na lista. A ordem dos itens (calculada no painel)
   * garante que nenhum clipe passe por cima de outro.
   * args: { seqId, moves: [{ v: 1|0, t, i, to }] }  to = início final em ticks
   */
  api.syncMove = function (args) {
    var seq = seqById(args.seqId);
    if (!seq) throw new Error("A sequência sincronizada sumiu do projeto.");
    // ⚠️ Pegar o clipe na hora de mover. Guardar as referências de todos antes
    // e mover depois fica cada vez mais lento (o Premiere re-resolve as
    // referências antigas depois de cada move): 700 movimentos levaram minutos;
    // pegando na hora, ~4 ms cada (medido em 26.5.1).
    var failed = [];
    var already = 0;
    for (var n = 0; n < args.moves.length; n++) {
      var mv = args.moves[n];
      try {
        var tr = mv.v ? seq.videoTracks[mv.t] : seq.audioTracks[mv.t];
        var clip = tr ? tr.clips[mv.i] : null;
        if (!clip) throw new Error("clipe não encontrado");
        var d = Math.round(mv.to) - ticksOf(clip.start);
        if (d === 0) { already++; continue; }
        var t = new Time();
        t.ticks = String(d);
        clip.move(t);
      } catch (e) {
        failed.push({ v: mv.v, t: mv.t, i: mv.i, error: e.message || String(e) });
      }
    }
    return { moved: args.moves.length - failed.length - already, already: already, failed: failed };
  };

  /**
   * Exporta a sequência como FCP XML (caminho mais rápido para criar a cópia:
   * ver js/sync/syncXml.js). ⚠️ exportAsFinalCutProXML só aceita barras
   * invertidas — com "/" devolve false sem dizer nada (26.5.1).
   * args: { seqId, path }
   */
  api.syncExportXml = function (args) {
    var seq = seqById(args.seqId);
    if (!seq) throw new Error("A sequência original sumiu do projeto.");
    var p = String(args.path).replace(/\//g, "\\");
    var f = new File(p);
    if (f.exists) f.remove();
    if (!seq.exportAsFinalCutProXML(p, 1) || !new File(p).exists) throw new Error("O Premiere não exportou o XML da sequência.");
    return { path: p };
  };

  /**
   * Importa o XML reescrito e devolve a sequência nova, na pasta args.bin.
   *
   * ⚠️ Na importação o Premiere reaproveita alguns itens do projeto mas cria
   * itens REPETIDOS de outros (WAV dos gravadores, vídeos — 26.5) — sem
   * diferença visível entre original e cópia além do contador de uso. Por isso a
   * importação vai para uma pasta temporária e cada clipe da sequência nova que
   * usa um item repetido é trocado pelo original no mesmo lugar e trecho — em
   * LOTES (syncReplaceDuplicates), porque numa sequência grande são centenas de
   * trocas e uma chamada única prendia o motor de scripts por dezenas de minutos
   * sem progresso (786 clipes, 21/10). Esta chamada só importa e monta a lista.
   * args: { path, name, bin, srcSeqId, expected }
   *   expected: { video: [[[início, itemId], …] por faixa], audio: […] } — onde cada clipe fica
   *   na cópia e o item que ele usa na origem (ver startReplaceJob)
   */
  api.syncImportXml = function (args) {
    var rootItem = app.project.rootItem;
    var bin = null;
    for (var i = 0; i < rootItem.children.numItems; i++) {
      var ch = rootItem.children[i];
      if (ch.type === ProjectItemType.BIN && ch.name === args.bin) bin = ch;
    }
    if (!bin) bin = rootItem.createBin(args.bin);
    var tmp = rootItem.createBin(args.bin + " (importando)");
    var before = {};
    for (var b = 0; b < app.project.sequences.numSequences; b++) before[app.project.sequences[b].sequenceID] = true;
    var p = String(args.path).replace(/\//g, "\\");
    var t0 = new Date().getTime();
    if (!app.project.importFiles([p], true, tmp, false)) {
      try { tmp.deleteBin(); } catch (eD) {}
      throw new Error("O Premiere não importou o XML.");
    }
    var copy = null;
    for (var j = 0; j < app.project.sequences.numSequences; j++) {
      var s = app.project.sequences[j];
      if (!before[s.sequenceID]) copy = s;
    }
    if (!copy) throw new Error("O XML foi importado, mas a sequência nova não apareceu no projeto (veja a pasta \"" + tmp.name + "\").");
    if (copy.name !== args.name) copy.name = args.name;
    copy.projectItem.moveBin(bin);
    var src = args.srcSeqId ? seqById(args.srcSeqId) : null;
    var importMs = new Date().getTime() - t0;
    replaceJob = startReplaceJob(copy, tmp, bin, src, args.expected);
    return { id: copy.sequenceID, name: copy.name, pending: replaceJob.work.length, importMs: importMs, listMs: new Date().getTime() - t0 - importMs };
  };

  /**
   * Faz um lote das trocas preparadas pelo syncImportXml (até args.budgetMs) e
   * devolve o progresso; o último lote apaga as faixas de áudio que as trocas
   * criaram e a pasta temporária (só repetidos sem uso).
   * args: { seqId, budgetMs }
   */
  api.syncReplaceDuplicates = function (args) {
    var job = replaceJob;
    if (!job || job.seqId !== args.seqId) throw new Error("A troca dos itens repetidos não está em andamento — crie a cópia de novo.");
    var seq = seqById(job.seqId);
    if (!seq) { replaceJob = null; throw new Error("A sequência sincronizada sumiu do projeto."); }
    var budget = Number(args.budgetMs) || 2000;
    var t0 = new Date().getTime();
    var A = seq.audioTracks;
    try {
      while (job.next < job.work.length && new Date().getTime() - t0 < budget) {
        var w = job.work[job.next++];
        var r = "kept";
        try { r = replaceWorkItem(seq, job, w); } catch (eW) { r = "kept"; }
        if (r === "replaced") job.replaced++;
        else if (r === "kept") { job.kept++; job.inUse[w.dupId] = true; }
      }
    } finally {
      // travas como o usuário deixou (as faixas novas ficam destravadas)
      for (var a = 0; a < job.locks.length && a < A.numTracks; a++) A[a].setLocked(job.locks[a] ? 1 : 0);
      job.lockedFor = null;
    }
    var out = { id: seq.sequenceID, name: seq.name, done: false, processed: job.next, total: job.work.length, replaced: job.replaced, kept: job.kept };
    if (job.next < job.work.length) return out;
    replaceJob = null;
    removeNewEmptyAudioTracks(seq, job.nA0);
    // o que está em uso (inclusive em subpastas da importação) vai para a pasta final; o resto são
    // repetidos sem uso e somem com a temporária, que é sempre apagada (21/10: ela ficou
    // vazia no projeto: só era apagada se tivesse apenas itens soltos)
    var unused = moveInUseOut(job.tmp, job);
    try { job.tmp.deleteBin(); } catch (eDel) {}
    out.done = true;
    out.removed = unused;
    return out;
  };

  var replaceJob = null;

  /** Move para job.bin os itens em uso da pasta (e subpastas); devolve quantos repetidos sem uso ficaram nela. */
  function moveInUseOut(folder, job) {
    var unused = 0;
    for (var k = folder.children.numItems - 1; k >= 0; k--) {
      var it = folder.children[k];
      if (it.type === ProjectItemType.BIN) unused += moveInUseOut(it, job);
      else if (job.inUse[it.nodeId]) it.moveBin(job.bin);
      else unused++;
    }
    return unused;
  }

  function normMediaPath(p) {
    return String(p || "").replace(/\//g, "\\").replace(/\\+/g, "\\").toLowerCase();
  }

  /**
   * Componentes que todo clipe tem (efeitos "intrínsecos"); qualquer outro conta
   * como efeito extra. Áudio (26.5.1): "Internal Volume Stereo", "Internal
   * Channel Volume Stereo"… — todos começam com "Internal ".
   */
  var INTRINSIC = { "AE.ADBE Motion": 1, "AE.ADBE Opacity": 1, "AE.ADBE Time Remapping": 1 };
  function hasExtraEffects(clip) {
    try {
      for (var c = 0; c < clip.components.numItems; c++) {
        var mn = clip.components[c].matchName;
        if (!INTRINSIC[mn] && !/^Internal /.test(mn)) return true;
      }
    } catch (e) { return true; }
    return false;
  }

  /**
   * Monta a lista de trocas numa passada só. "Original" de um arquivo = o item
   * que a sequência de ORIGEM usa para ele; clipe da sequência nova com outro
   * item para o mesmo arquivo (criado agora na pasta temporária ou repetido de
   * uma criação anterior) entra na lista. Com `expected` (o painel diz onde cada
   * clipe fica e qual item ele usa na origem), o par é pelo ITEM da origem, não pelo
   * caminho: em 21/10 câmeras com arquivos de mesmo nome em pastas diferentes
   * (C1/C0168.mp4 e C2/C0168.mp4) fizeram a importação ligar 68 clipes ao arquivo da OUTRA câmera —
   * um item original válido, que o par por caminho não via como errado. E um arquivo
   * com dois itens no projeto (overlays em 3 pastas) continua com o item da origem.
   * Guarda só faixa + início (ticks): o
   * clipe é buscado de novo na hora da troca (referências antigas ficam lentas
   * e os vizinhos mudam a cada overwrite). Vídeos antes dos áudios: o áudio
   * vinculado é trocado junto com o vídeo dele.
   */
  function startReplaceJob(seq, tmp, bin, src, expected) {
    var job = { seqId: seq.sequenceID, tmp: tmp, bin: bin, work: [], next: 0, replaced: 0, kept: 0, inUse: {}, originals: {}, itemById: {}, expected: expected || null, audioTrackOf: {}, frame: Number(seq.timebase), nA0: seq.audioTracks.numTracks, locks: [], lockedFor: null };
    for (var a = 0; a < seq.audioTracks.numTracks; a++) job.locks.push(seq.audioTracks[a].isLocked() ? true : false);
    if (!src) {
      for (var q = 0; q < tmp.children.numItems; q++) job.inUse[tmp.children[q].nodeId] = true;
      return job;
    }
    var srcTracks = [src.videoTracks, src.audioTracks];
    for (var sk = 0; sk < 2; sk++) {
      for (var st = 0; st < srcTracks[sk].numTracks; st++) {
        var sTrack = srcTracks[sk][st];
        var sClips = sTrack.clips, sn = sClips.numItems;
        for (var sc = 0; sc < sn; sc++) {
          var spi = null;
          try { spi = sClips[sc].projectItem; } catch (eS) {}
          if (!spi) continue;
          job.itemById[spi.nodeId] = spi;
          var sp = "";
          try { sp = normMediaPath(spi.getMediaPath()); } catch (eM) {}
          if (sp && !job.originals[sp]) job.originals[sp] = spi;
        }
      }
    }
    var pathOf = {}; // nodeId -> caminho (cache: getMediaPath custa)
    var TRACKS = [seq.videoTracks, seq.audioTracks];
    for (var kind = 0; kind < 2; kind++) {
      for (var t = 0; t < TRACKS[kind].numTracks; t++) {
        var clips = TRACKS[kind][t].clips, n = clips.numItems;
        for (var c = 0; c < n; c++) {
          var clip = clips[c];
          if (kind === 1) job.audioTrackOf[clip.nodeId] = t;
          var pi = null;
          try { pi = clip.projectItem; } catch (eP) {}
          if (!pi) continue;
          var id = pi.nodeId;
          if (pathOf[id] === undefined) {
            try { pathOf[id] = normMediaPath(pi.getMediaPath()); } catch (eM2) { pathOf[id] = ""; }
          }
          // item esperado (o da origem) pela posição na cópia; sem a lista, pelo caminho
          var original = null, exp = job.expected ? expectedItemId(job.expected[kind ? "audio" : "video"][t], ticksOf(clip.start), job.frame) : null;
          if (exp && job.itemById[exp]) original = job.itemById[exp];
          else if (!job.expected) original = job.originals[pathOf[id]];
          // já é o original, ou não tem par na origem (sequência aninhada, gráfico…): fica como veio e,
          // se estiver na pasta temporária, vai para a pasta final em vez de ser apagado com ela
          if (!original || original.nodeId === id) { job.inUse[id] = true; continue; }
          if (hasExtraEffects(clip) || clip.disabled) { job.kept++; job.inUse[id] = true; continue; }
          job.work.push({ kind: kind, t: t, start: ticksOf(clip.start), dupId: id, origId: original.nodeId });
        }
      }
    }
    return job;
  }

  var TICK_TOL = 254016000000 / 1000; // 1 ms

  /**
   * Item esperado para o clipe que começa em `ticks` numa faixa da cópia. A lista
   * vem do painel com o destino exato; o XML arredonda o início para quadros da
   * sequência → aceita o mais próximo a até meio quadro.
   */
  function expectedItemId(list, ticks, frame) {
    if (!list || !list.length) return null;
    var lo = 0, hi = list.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid][0] < ticks) lo = mid + 1;
      else hi = mid;
    }
    var best = null, bd = Infinity;
    for (var i = Math.max(0, lo - 1); i <= Math.min(list.length - 1, lo + 1); i++) {
      var d = Math.abs(list[i][0] - ticks);
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best && bd <= frame / 2 + TICK_TOL ? String(best[1]) : null;
  }

  /** Índice do 1º clipe da faixa com início ≥ ticks − 1 ms (clipes em ordem de início). */
  function lowerClipIndex(clips, ticks) {
    var lo = 0, hi = clips.numItems;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (ticksOf(clips[mid].start) < ticks - TICK_TOL) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Clipe da faixa que começa em `ticks` (± 1 ms), ou null. */
  function clipStartingAt(track, ticks) {
    var clips = track.clips;
    var i = lowerClipIndex(clips, ticks);
    if (i < clips.numItems && Math.abs(ticksOf(clips[i].start) - ticks) <= TICK_TOL) return clips[i];
    return null;
  }

  /** Remove os clipes do item `nodeId` contidos em [start, end] (sobras do repetido). */
  function removeItemClipsIn(track, nodeId, start, end) {
    var clips = track.clips;
    var i = lowerClipIndex(clips, start), hits = [];
    for (; i < clips.numItems; i++) {
      var r = clips[i];
      if (ticksOf(r.start) > end + TICK_TOL) break;
      if (ticksOf(r.end) <= end + TICK_TOL && r.projectItem && r.projectItem.nodeId === nodeId) hits.push(r);
    }
    for (var h = hits.length - 1; h >= 0; h--) hits[h].remove(false, false);
  }

  /**
   * Faz uma troca da lista: "replaced", "kept" (o repetido fica em uso) ou
   * "skip" (o clipe já não usa o repetido — ex.: áudio trocado junto com o vídeo).
   */
  function replaceWorkItem(seq, job, w) {
    var track = w.kind === 0 ? seq.videoTracks[w.t] : seq.audioTracks[w.t];
    var clip = track ? clipStartingAt(track, w.start) : null;
    if (!clip || !clip.projectItem || clip.projectItem.nodeId !== w.dupId) return "skip";
    var original = job.itemById[w.origId] || job.originals[normMediaPath(clip.projectItem.getMediaPath())];
    if (w.kind === 0) return replaceVideoClip(seq, job, w.t, clip, original) ? "replaced" : "kept";
    // áudio: só o que não tem vínculo (o vinculado vai com o vídeo dele)
    var linked = 0;
    try { var L = clip.getLinkedItems(); linked = L ? L.numItems : 0; } catch (eL) {}
    if (linked) return "kept";
    setAudioLocks(seq, job, "all-open");
    return replaceClipItem(track, clip, original, job.frame) ? "replaced" : "kept";
  }

  /**
   * Travas das faixas de áudio para o overwrite: "all-open" = como o usuário
   * deixou; número = só essa faixa destravada; -1 = todas travadas. Só mexe
   * quando muda (a lista vem em ordem de faixa).
   */
  function setAudioLocks(seq, job, mode) {
    if (job.lockedFor === mode) return;
    var A = seq.audioTracks;
    for (var a = 0; a < job.nA0; a++) {
      var lock = mode === "all-open" ? job.locks[a] : a !== mode;
      A[a].setLocked(lock ? 1 : 0);
    }
    job.lockedFor = mode;
  }

  /**
   * Troca um clipe de VÍDEO repetido pelo original. O overwriteClip traz o áudio
   * do arquivo junto e o põe na 1ª faixa de áudio DESTRAVADA com número ≥ o da
   * faixa de vídeo (cria uma nova se não houver) — medido 13/10. Então:
   *  - com áudio vinculado (a câmera tem o som dela na sequência): todas as faixas
   *    de áudio travadas menos a desse áudio → original entra com vídeo e áudio
   *    exatamente onde estavam os repetidos; o gravador fica travado;
   *  - sem áudio vinculado: tudo travado → o áudio cai numa faixa nova e sai
   *    (as faixas novas vazias são apagadas no fim da lista).
   * Fica o repetido (false) se: áudio vinculado em mais de uma faixa, com trecho
   * diferente do vídeo (J/L-cut) ou numa faixa ABAIXO da do vídeo (não dá para
   * direcionar para baixo).
   */
  function replaceVideoClip(seq, job, v, clip, original) {
    var tb = TICK_TOL;
    var start = ticksOf(clip.start), end = ticksOf(clip.end), inP = ticksOf(clip.inPoint);
    var dupId = clip.projectItem.nodeId;
    var A = seq.audioTracks, dest = -1, la = null, n = 0, laOut = 0;
    var L = null;
    try { L = clip.getLinkedItems(); } catch (eL) {}
    if (L) for (var i = 0; i < L.numItems; i++) if (L[i].mediaType === "Audio") { la = L[i]; n++; }
    if (n > 1) return false;
    if (la) {
      if (Math.abs(ticksOf(la.start) - start) > tb || Math.abs(ticksOf(la.end) - end) > tb || Math.abs(ticksOf(la.inPoint) - inP) > tb) return false;
      laOut = ticksOf(la.outPoint);
      dest = job.audioTrackOf[la.nodeId];
      if (dest === undefined) dest = trackIndexOf(A, la);
      if (dest < v || dest >= job.nA0) return false;
    }
    setAudioLocks(seq, job, dest);
    var ok = replaceClipItem(seq.videoTracks[v], clip, original, job.frame);
    if (dest >= 0) {
      // sobra do áudio repetido e acerto fino do áudio novo (igual ao vídeo)
      var tr = A[dest];
      removeItemClipsIn(tr, dupId, start - tb, end);
      var c = clipStartingAt(tr, start);
      var got = false;
      if (c && c.projectItem && c.projectItem.nodeId === original.nodeId) {
        if (ticksOf(c.start) !== start) c.start = timeFromTicks(start);
        if (ticksOf(c.inPoint) !== inP) c.inPoint = timeFromTicks(inP);
        if (ticksOf(c.end) !== end) c.end = timeFromTicks(end);
        if (ticksOf(c.outPoint) !== laOut) c.outPoint = timeFromTicks(laOut);
        got = ticksOf(c.start) === start && ticksOf(c.end) === end && Math.abs(ticksOf(c.inPoint) - inP) <= tb && Math.abs(ticksOf(c.outPoint) - laOut) <= tb;
      }
      ok = ok && got;
    } else {
      // sem áudio na origem: o que o overwrite pôs numa faixa nova sai
      for (var t2 = job.nA0; t2 < A.numTracks; t2++) removeItemClipsIn(A[t2], original.nodeId, start - tb, end + tb);
    }
    return ok;
  }

  function trackIndexOf(tracks, item) {
    for (var t = 0; t < tracks.numTracks; t++) {
      for (var c = 0; c < tracks[t].clips.numItems; c++) if (tracks[t].clips[c].nodeId === item.nodeId) return t;
    }
    return -1;
  }

  /** Apaga as faixas de áudio vazias de índice ≥ from (criadas pelo overwrite). Precisa da sequência ativa (QE). */
  function removeNewEmptyAudioTracks(seq, from) {
    if (seq.audioTracks.numTracks <= from) return;
    var act = app.project.activeSequence;
    if (!act || act.sequenceID !== seq.sequenceID) app.project.openSequence(seq.sequenceID);
    var q = qeSeqFor(seq);
    for (var t = seq.audioTracks.numTracks - 1; t >= from; t--) {
      if (seq.audioTracks[t].clips.numItems === 0) q.removeAudioTrack(t);
    }
  }

  /**
   * Troca o item de um clipe sem vínculo pelo original: mesmo início, fim e
   * trecho da mídia. Sem remove(): o overwriteClip cobre exatamente o trecho do
   * repetido. Antes, confere que o trecho (in/out) pegou no item — senão o
   * overwrite entraria com o arquivo inteiro por cima dos vizinhos.
   */
  function replaceClipItem(track, clip, original, frame) {
    var tb = TICK_TOL;
    var start = ticksOf(clip.start), end = ticksOf(clip.end), inP = ticksOf(clip.inPoint), outP = ticksOf(clip.outPoint);
    var oldIn = original.getInPoint(), oldOut = original.getOutPoint();
    var tIn = new Time(); tIn.ticks = String(inP);
    var tOut = new Time(); tOut.ticks = String(outP);
    var at = new Time(); at.ticks = String(start);
    var ok = false;
    try {
      // ⚠️ setIn/OutPoint arredondam para a grade do PRÓPRIO arquivo (WAV com
      // timecode 25 fps → 40 ms: in 3,70370 vira 3,68) e o fim é limitado ao
      // tamanho do arquivo (o XML arredonda a duração para quadros inteiros da
      // sequência). Regra: entrada do item no ponto da grade ATÉ 0,1 s antes da do
      // clipe e saída com a mesma duração — o trecho do item nunca passa do
      // tamanho do clipe, então o overwrite não invade o vizinho; depois a entrada
      // e o fim do clipe são acertados ao tick. (Antes a entrada tinha de pegar
      // exata e esses WAV ficavam com o item repetido — 7 num teste de 21/10.)
      // ⚠️ passar Time (ticks), não segundos: 2,0354 s (quadro 61 exato) em segundos
      // virava o quadro 60 e a troca era recusada (medido 13/10, 2.6.2)
      var slack = 254016000000 / 10;
      original.setInPoint(tIn, 4);
      if (ticksOf(original.getInPoint()) > inP + tb) original.setInPoint(timeFromTicks(inP - slack / 2), 4);
      var gotIn = ticksOf(original.getInPoint());
      if (gotIn > inP + tb || inP - gotIn > slack) return false;
      var wantOut = outP - Math.max(0, inP - gotIn); // mesma duração a partir da entrada que pegou
      original.setOutPoint(timeFromTicks(wantOut), 4);
      if (ticksOf(original.getOutPoint()) > wantOut + tb) original.setOutPoint(timeFromTicks(wantOut - slack / 2), 4);
      var gotOut = ticksOf(original.getOutPoint());
      if (gotOut > wantOut + tb || wantOut - gotOut > slack + frame) return false;
      var dupId = clip.projectItem.nodeId;
      track.overwriteClip(original, at);
      // sobra do repetido entre o fim do item e o fim do clipe: sai antes de esticar
      removeItemClipsIn(track, dupId, start - tb, end);
      var c = clipStartingAt(track, start);
      if (c && c.projectItem && c.projectItem.nodeId === original.nodeId) {
        // acerto fino ao tick (o in/out do item vai em segundos)
        if (ticksOf(c.start) !== start) { c.start = at; }
        if (ticksOf(c.inPoint) !== inP) { c.inPoint = tIn; }
        if (ticksOf(c.end) !== end) { var e = new Time(); e.ticks = String(end); c.end = e; }
        // ⚠️ esticar o fim não atualiza a saída informada (ficava 1–2 q menor nos WAV, 21/10)
        if (ticksOf(c.outPoint) !== outP) c.outPoint = tOut;
        ok = ticksOf(c.start) === start && ticksOf(c.end) === end && Math.abs(ticksOf(c.inPoint) - inP) <= tb && Math.abs(ticksOf(c.outPoint) - outP) <= tb;
      }
    } finally {
      try { original.setInPoint(oldIn, 4); original.setOutPoint(oldOut, 4); } catch (eR) {}
    }
    return ok;
  }

  /** args: { seqId } */
  api.syncOpen = function (args) {
    var seq = seqById(args.seqId);
    if (!seq) throw new Error("A sequência sincronizada sumiu do projeto.");
    app.project.openSequence(seq.sequenceID);
    return { ok: true };
  };

  // ------------------------------------------------------------ dispatch
  return {
    call: function (name, argsJSON) {
      try {
        if (!api[name]) throw new Error("função desconhecida: " + name);
        var args = argsJSON ? fromJSON(argsJSON) : {};
        return toJSON({ ok: true, data: api[name](args) });
      } catch (e) {
        return toJSON({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    },
  };
})();
