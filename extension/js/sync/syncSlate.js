/**
 * syncSlate.js — batida pela claquete RECONHECIDA (referência da claquete da produtora, decisão do usuário 15/10).
 *
 * Segunda opinião para onde o detector de "movimento que para" (syncClap) falha: câmera em movimento
 * (gimbal) e batida não achada. Medido no banco (teste curto, 20 câmeras): 6 certas, 0 erradas — inclui
 * CHIARO4728/4730, que o detector antigo errava por 2–3 s.
 *
 *  1. Seguir o corpo do quadro (referência em img/claquete-ref.slt) em 480 px: NCC média dos 3 canais
 *     (tolera a curva de cor de cada câmera), multiescala por FFT; escala pela nitidez do pico (z) —
 *     modelo pequeno "encaixa" em tudo. Depois só refino local; no borrão da batida o encaixe cai e o
 *     seguimento continua até 15 quadros com NCC ≥ 0,35.
 *  2. Espelho na resolução ORIGINAL (recorte das barras): com a ripa fechada, as listras de cima são o
 *     reflexo das de baixo. Linha de contato procurada, claquete podendo estar inclinada (±15°).
 *  3. Batida = degrau de espelho relativo à própria claquete (≥ 0,25), no 1º quadro JÁ fechado (85% do
 *     degrau), e a ripa FICA fechada até a claquete sair de cena (≥ 80%) — fechamento de ensaio reabre;
 *     e a claquete foi mostrada por ≥ 0,8 s antes (vulto de relance no cenário não conta).
 *     Fica a última. Instante = meio quadro antes desse quadro.
 *
 * Depende de: AESyncFfmpeg (rgb). Funções puras exportadas para os testes.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncSlate = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULTS = {
    scanSec: 25,
    sw: 480, sh: 270, // imagem do seguimento
    bar: 0.107, // altura de uma barra / largura do corpo (medido na referência)
    found: 0.55, // encaixe bom
    minW: 28, // menor claquete real vista (px em 480); abaixo disso, encaixe falso de canto
    coast: 0.35, coastFrames: 15, // borrão da batida
    searchEvery: 15, // busca completa (sem claquete) a cada 15 quadros (0,5 s; a claquete é mostrada ≥ 1 s antes de bater)
    maxTilt: 15, // graus
    mirrorW: 160, // largura da claquete no recorte do espelho (barra ≈ 17 px): reduz os closes 4K, mantém a C70 aberta
    jump: 0.25, closedFrac: 0.85, stay: 0.8,
    shownSec: 0.8, // a claquete é mostrada antes de bater (medido: 1,1–8 s); um vulto de relance não (falso da CHIARO4729: 0,5 s)
  };

  // ---------------------------------------------------------------- FFT 2D
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < half; k++) { const a = i + k, b = a + half; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  function fft2(re, im, N, M, inverse) {
    const r = new Float64Array(M), i2 = new Float64Array(M);
    for (let y = 0; y < N; y++) { for (let x = 0; x < M; x++) { r[x] = re[y * M + x]; i2[x] = im[y * M + x]; } fft(r, i2, inverse); for (let x = 0; x < M; x++) { re[y * M + x] = r[x]; im[y * M + x] = i2[x]; } }
    const c = new Float64Array(N), ci = new Float64Array(N);
    for (let x = 0; x < M; x++) { for (let y = 0; y < N; y++) { c[y] = re[y * M + x]; ci[y] = im[y * M + x]; } fft(c, ci, inverse); for (let y = 0; y < N; y++) { re[y * M + x] = c[y]; im[y * M + x] = ci[y]; } }
  }
  const p2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  /** redução por média de área / ampliação por amostra */
  function resize(src, sw, sh, dw, dh) {
    const out = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const x0 = (x * sw) / dw, x1 = ((x + 1) * sw) / dw, y0 = (y * sh) / dh, y1 = ((y + 1) * sh) / dh;
      let s = 0, n = 0;
      for (let yy = Math.floor(y0); yy < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); yy++) for (let xx = Math.floor(x0); xx < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); xx++) { s += src[Math.min(sh - 1, yy) * sw + Math.min(sw - 1, xx)]; n++; }
      out[y * dw + x] = s / n;
    }
    return out;
  }
  /** RGB intercalado → 3 planos Float32 */
  function planes(rgb, n) {
    const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) { ch[0][i] = rgb[3 * i]; ch[1][i] = rgb[3 * i + 1]; ch[2][i] = rgb[3 * i + 2]; }
    return ch;
  }

  // ---------------------------------------------------------------- NCC
  function prepImage(img, W, H) {
    const N = p2(H), M = p2(W);
    const re = new Float64Array(N * M), im = new Float64Array(N * M);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) re[y * M + x] = img[y * W + x];
    fft2(re, im, N, M, false);
    const S = new Float64Array((W + 1) * (H + 1)), S2 = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let a = 0, b = 0; for (let x = 0; x < W; x++) { const v = img[y * W + x]; a += v; b += v * v; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + a; S2[(y + 1) * (W + 1) + x + 1] = S2[y * (W + 1) + x + 1] + b; } }
    return { W, H, N, M, re, im, S, S2 };
  }
  /** espectro do modelo (sem a média) num quadro N×M — não depende da imagem: guardado entre buscas */
  function tplSpectrum(t, tw, th, N, M) {
    let mt = 0; for (let i = 0; i < tw * th; i++) mt += t[i]; mt /= tw * th;
    let nt = 0;
    const re = new Float64Array(N * M), im = new Float64Array(N * M);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const v = t[y * tw + x] - mt; re[y * M + x] = v; nt += v * v; }
    fft2(re, im, N, M, false);
    return { re: Float32Array.from(re), im: Float32Array.from(im), nt: Math.sqrt(nt) };
  }
  const specCache = new WeakMap(); // referência → Map(tamanho → espectro), vale para todas as câmeras
  function nccMap(P, t, tw, th, spec) {
    const { W, H, N, M } = P;
    const T = spec || tplSpectrum(t, tw, th, N, M), nt = T.nt;
    const re = new Float64Array(N * M), im = new Float64Array(N * M);
    for (let k = 0; k < N * M; k++) { const a = P.re[k], b = P.im[k], c = T.re[k], d = -T.im[k]; re[k] = a * c - b * d; im[k] = a * d + b * c; }
    fft2(re, im, N, M, true);
    const oW = W - tw + 1, oH = H - th + 1, out = new Float32Array(oW * oH), n = tw * th, S = P.S, S2 = P.S2, W1 = W + 1;
    for (let y = 0; y < oH; y++) for (let x = 0; x < oW; x++) {
      const s = S[(y + th) * W1 + x + tw] - S[y * W1 + x + tw] - S[(y + th) * W1 + x] + S[y * W1 + x];
      const s2 = S2[(y + th) * W1 + x + tw] - S2[y * W1 + x + tw] - S2[(y + th) * W1 + x] + S2[y * W1 + x];
      const v = s2 - (s * s) / n;
      out[y * oW + x] = v > 1e-6 ? re[y * M + x] / (Math.sqrt(v) * nt) : 0;
    }
    return { out, oW, oH };
  }
  /** busca multiescala, NCC média dos 3 canais; escala pela nitidez z do pico */
  /** normaliza a correlação crua (re) numa NCC por posição */
  function normalize(P, raw, tw, th, nt, acc) {
    const { W, H, M } = P, oW = W - tw + 1, oH = H - th + 1, n = tw * th, S = P.S, S2 = P.S2, W1 = W + 1;
    for (let y = 0; y < oH; y++) for (let x = 0; x < oW; x++) {
      const s = S[(y + th) * W1 + x + tw] - S[y * W1 + x + tw] - S[(y + th) * W1 + x] + S[y * W1 + x];
      const s2 = S2[(y + th) * W1 + x + tw] - S2[y * W1 + x + tw] - S2[(y + th) * W1 + x] + S2[y * W1 + x];
      const v = s2 - (s * s) / n;
      acc[y * oW + x] += v > 1e-6 ? raw[y * M + x] / (Math.sqrt(v) * nt) : 0;
    }
  }
  function searchRGB(imgs, W, H, refs, rw, rh, widths, cache) {
    const Ps = imgs.map((im) => prepImage(im, W, H));
    const N = Ps[0].N, M = Ps[0].M, NM = N * M;
    let best = null;
    for (const tw of widths) {
      const th = Math.round((tw * rh) / rw);
      if (tw >= W || th >= H) continue;
      // espectro do modelo guardado (cache) — a referência e o tamanho do quadro não mudam entre buscas
      const specs = [0, 1, 2].map((c) => {
        const key = `${W}x${H}:${tw}:${c}`;
        let spec = cache && cache.get(key);
        if (!spec) { spec = tplSpectrum(resize(refs[c], rw, rh, tw, th), tw, th, N, M); if (cache) cache.set(key, spec); }
        return spec;
      });
      const oW = W - tw + 1, oH = H - th + 1, acc = new Float32Array(oW * oH);
      // as correlações são reais: canais 0 e 1 numa só inversa complexa (X0 + i·X1), canal 2 sozinho
      const re = new Float64Array(NM), im = new Float64Array(NM);
      for (let k = 0; k < NM; k++) {
        const a0 = Ps[0].re[k], b0 = Ps[0].im[k], c0 = specs[0].re[k], d0 = -specs[0].im[k];
        const a1 = Ps[1].re[k], b1 = Ps[1].im[k], c1 = specs[1].re[k], d1 = -specs[1].im[k];
        const r0 = a0 * c0 - b0 * d0, i0 = a0 * d0 + b0 * c0, r1 = a1 * c1 - b1 * d1, i1 = a1 * d1 + b1 * c1;
        re[k] = r0 - i1; im[k] = i0 + r1;
      }
      fft2(re, im, N, M, true);
      normalize(Ps[0], re, tw, th, specs[0].nt, acc);
      normalize(Ps[1], im, tw, th, specs[1].nt, acc);
      const re2 = new Float64Array(NM), im2 = new Float64Array(NM);
      for (let k = 0; k < NM; k++) { const a = Ps[2].re[k], b = Ps[2].im[k], c = specs[2].re[k], d = -specs[2].im[k]; re2[k] = a * c - b * d; im2[k] = a * d + b * c; }
      fft2(re2, im2, N, M, true);
      normalize(Ps[2], re2, tw, th, specs[2].nt, acc);
      let s = 0, s2 = 0, bi = 0;
      for (let i = 0; i < acc.length; i++) { acc[i] /= 3; s += acc[i]; s2 += acc[i] * acc[i]; if (acc[i] > acc[bi]) bi = i; }
      const mean = s / acc.length, sd = Math.sqrt(Math.max(1e-9, s2 / acc.length - mean * mean));
      const z = (acc[bi] - mean) / sd;
      if (!best || z > best.z) best = { x: bi % oW, y: (bi / oW) | 0, w: tw, h: th, score: acc[bi], z };
    }
    return best;
  }
  /** NCC direta (3 canais) de um modelo numa posição */
  function nccAt(imgs, W, H, tpl, tw, th, x0, y0) {
    let acc = 0;
    for (let c = 0; c < 3; c++) {
      const im = imgs[c], t = tpl[c];
      let sf = 0, sf2 = 0, st = 0, st2 = 0, sft = 0; const n = tw * th;
      for (let y = 0; y < th; y++) { const yy = y0 + y; if (yy < 0 || yy >= H) return -1; for (let x = 0; x < tw; x++) { const xx = x0 + x; if (xx < 0 || xx >= W) return -1; const f = im[yy * W + xx], v = t[y * tw + x]; sf += f; sf2 += f * f; st += v; st2 += v * v; sft += f * v; } }
      const cov = sft - (sf * st) / n, vf = sf2 - (sf * sf) / n, vt = st2 - (st * st) / n;
      acc += vf > 1e-6 && vt > 1e-6 ? cov / Math.sqrt(vf * vt) : 0;
    }
    return acc / 3;
  }

  // ---------------------------------------------------------------- referência
  /** img/claquete-ref.slt: 'SLT1' + u32 L + u32 A + RGB */
  function parseRef(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "SLT1") throw new Error("referência da claquete inválida");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const w = dv.getUint32(4, true), h = dv.getUint32(8, true);
    return { w, h, ch: planes(b.subarray(12), w * h) };
  }

  /**
   * Seguidor (passo 1): push(rgb 480×270, t) quadro a quadro; rows = [{ t, score, x, y, w }].
   */
  function Tracker(ref, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    this.o = o; this.ref = ref;
    this.widths = []; for (let w = 22; w <= 200; w = Math.round(w * 1.12)) this.widths.push(w);
    this.tpl = new Map();
    this.box = null; this.lastSearch = -1e9; this.n = 0; this.good = 0; this.rows = [];
  }
  Tracker.prototype.tplOf = function (tw) {
    if (!this.tpl.has(tw)) { const r = this.ref, th = Math.round((tw * r.h) / r.w); this.tpl.set(tw, { th, t: r.ch.map((c) => resize(c, r.w, r.h, tw, th)) }); }
    return this.tpl.get(tw);
  };
  Tracker.prototype.push = function (rgb, t) {
    const o = this.o, W = o.sw, H = o.sh, small = planes(rgb, W * H);
    if (!this.box && this.n - this.lastSearch >= o.searchEvery) {
      this.lastSearch = this.n;
      // busca grossa em 240 e refino em 480
      const q = small.map((c) => { const out = new Float32Array((W >> 1) * (H >> 1)); for (let y = 0; y < H >> 1; y++) for (let x = 0; x < W >> 1; x++) { const i = 2 * y * W + 2 * x; out[y * (W >> 1) + x] = (c[i] + c[i + 1] + c[i + W] + c[i + W + 1]) / 4; } return out; });
      // busca grossa com passo de 18% (o refino a seguir cobre ±12%)
      const ws = []; for (let w = 11; w <= 100; w = Math.round(w * 1.18)) ws.push(w);
      if (!specCache.has(this.ref)) specCache.set(this.ref, new Map());
      const b = searchRGB(q, W >> 1, H >> 1, this.ref.ch, this.ref.w, this.ref.h, ws, specCache.get(this.ref));
      this.box = b ? { x: b.x * 2, y: b.y * 2, w: b.w * 2 } : null;
      this.good = 0;
    }
    if (this.box) {
      const box = this.box;
      let best = null;
      for (const tw of this.widths) {
        if (Math.abs(Math.log(tw / box.w)) >= 0.12) continue;
        const T = this.tplOf(tw);
        // grade de 2 em 2 px (±6) e depois ±1 px em volta do melhor dela
        let g = null;
        for (let dy = -6; dy <= 6; dy += 2) for (let dx = -6; dx <= 6; dx += 2) {
          const s = nccAt(small, W, H, T.t, tw, T.th, box.x + dx, box.y + dy);
          if (!g || s > g.score) g = { x: box.x + dx, y: box.y + dy, w: tw, score: s };
        }
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const s = nccAt(small, W, H, T.t, tw, T.th, g.x + dx, g.y + dy);
          if (s > g.score) g = { x: g.x + dx, y: g.y + dy, w: tw, score: s };
        }
        if (!best || g.score > best.score) best = g;
      }
      if (best && best.score >= o.found && best.w >= o.minW) { this.box = best; this.good = o.coastFrames; }
      else if (best && this.good > 0 && best.score >= o.coast && best.w >= o.minW) { this.box = best; this.good--; }
      else this.box = null;
    }
    const b = this.box;
    this.rows.push({ t, score: b ? b.score : 0, x: b ? b.x : null, y: b ? b.y : null, w: b ? b.w : null, m: null });
    this.n++;
  };

  /**
   * Espelho (passo 2) num recorte RGB W×H: claquete com corpo em (bx, by), largura bw (px do recorte).
   * Ângulos de 5 em 5° e refino ±2,5° no melhor.
   */
  function mirror(img, W, H, bx, by, bw, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const X0 = Math.max(0, Math.round(bx + 0.25 * bw)), X1 = Math.min(W, Math.round(bx + bw));
    const b = Math.max(3, Math.round(o.bar * bw)), rows = Math.max(2, Math.round(0.6 * b));
    const xm = (X0 + X1) / 2;
    const at = (deg) => {
      const sl = Math.tan((deg * Math.PI) / 180), span = Math.ceil((Math.abs(sl) * (X1 - X0)) / 2);
      let best = -1;
      for (let yc = Math.round(by - 1.4 * b) - span; yc <= Math.round(by - 0.6 * b) + span; yc++) {
        let acc = 0, ok = true;
        for (let c = 0; c < 3 && ok; c++) {
          let su = 0, sl2u = 0, sll = 0, sl2 = 0, sul = 0, n = 0;
          for (let x = X0; x < X1; x++) {
            const y0 = Math.round(yc + (x - xm) * sl);
            for (let k = 0; k < rows; k++) {
              const yu = y0 - 1 - k, yl = y0 + k;
              if (yu < 0 || yl >= H) continue;
              const u = img[3 * (yu * W + x) + c], l = img[3 * (yl * W + x) + c];
              su += u; sll += l; sl2u += u * u; sl2 += l * l; sul += u * l; n++;
            }
          }
          if (n < 20) { ok = false; break; }
          const cov = sul - (su * sll) / n, vu = sl2u - (su * su) / n, vl = sl2 - (sll * sll) / n;
          acc += vu > 1e-6 && vl > 1e-6 ? cov / Math.sqrt(vu * vl) : 0;
        }
        if (ok && acc / 3 > best) best = acc / 3;
      }
      return best;
    };
    let bestDeg = 0, best = -1;
    for (let d = -o.maxTilt; d <= o.maxTilt; d += 5) { const v = at(d); if (v > best) { best = v; bestDeg = d; } }
    for (const d of [bestDeg - 2.5, bestDeg + 2.5]) { if (Math.abs(d) > o.maxTilt) continue; const v = at(d); if (v > best) { best = v; bestDeg = d; } }
    return best < 0 ? null : best;
  }

  /** Batida nos quadros com espelho medido (passo 3). rows: [{ t, score, m }]. Devolve a última ou null. */
  function findClap(rows, fps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const segs = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].m == null) continue;
      const s = segs[segs.length - 1];
      if (s && s.b === i - 1) s.b = i; else segs.push({ a: i, b: i });
    }
    const out = [];
    for (const s of segs) {
      const m = rows.slice(s.a, s.b + 1).map((r) => r.m);
      for (let k = Math.max(3, Math.round(o.shownSec * fps)); k < m.length; k++) {
        const after = m.slice(k);
        if (after.length < 3) continue;
        const before = med(m.slice(Math.max(0, k - 6), k)), closed = med(after.slice(0, 6));
        if (closed - before < o.jump) continue;
        const thr = before + o.closedFrac * (closed - before), mid = (before + closed) / 2;
        if (!(m[k] >= thr && m[k - 1] < thr)) continue;
        // a claquete tinha sido bem encaixada pouco antes (o borrão da batida derruba o encaixe)
        if (Math.max(...rows.slice(Math.max(s.a, s.a + k - 6), s.a + k + 1).map((r) => r.score)) < o.found) continue;
        const stay = after.filter((v) => v >= mid).length / after.length;
        if (stay < o.stay) continue;
        out.push({ t: rows[s.a + k].t - 0.5 / fps, open: before, closed, stay });
      }
    }
    return out.length ? out[out.length - 1] : null;
  }

  /**
   * Procura a batida no começo do vídeo (s no arquivo) ou null.
   * @param FF AESyncFfmpeg · exe ffmpeg · info probe do vídeo · ref parseRef(…)
   */
  async function find(FF, exe, file, info, ref, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const tr = new Tracker(ref, o);
    await FF.rgb(exe, file, info, { t: o.scanSec, w: o.sw, h: o.sh, fast: true, signal: o.signal }, (rgb, t) => tr.push(rgb, t));
    const rows = tr.rows, K = info.w / o.sw;
    const idx = rows.map((r, i) => (r.x != null ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return null;
    const chunks = [];
    for (const i of idx) { const c = chunks[chunks.length - 1]; if (c && i === c.b + 1 && c.b - c.a < 29) c.b = i; else chunks.push({ a: i, b: i }); }
    const tilt = Math.tan((o.maxTilt * Math.PI) / 180);
    for (const c of chunks) {
      const sel = rows.slice(c.a, c.b + 1);
      const bw = Math.max(...sel.map((r) => r.w)) * K, b = o.bar * bw;
      const x0 = Math.max(0, Math.floor(Math.min(...sel.map((r) => r.x)) * K - 0.05 * bw));
      const x1 = Math.min(info.w, Math.ceil(Math.max(...sel.map((r) => r.x + r.w)) * K + 0.05 * bw));
      const y0 = Math.max(0, Math.floor(Math.min(...sel.map((r) => r.y)) * K - 2.6 * b - (tilt * bw) / 2 - 12));
      const y1 = Math.min(info.h, Math.ceil(Math.max(...sel.map((r) => r.y)) * K + 0.4 * b + (tilt * bw) / 2 + 12));
      const cw = (x1 - x0) & ~1, chh = (y1 - y0) & ~1;
      if (cw < 16 || chh < 16) continue;
      // recorte da resolução original, reduzido até a claquete ter ~mirrorW px (nunca ampliado)
      const s = Math.min(1, o.mirrorW / bw), ow = Math.max(16, Math.round(cw * s) & ~1), oh = Math.max(16, Math.round(chh * s) & ~1);
      const sx = ow / cw, sy = oh / chh;
      const byFrame = new Map(sel.map((r) => [Math.round(r.t * info.fps), r]));
      await FF.rgb(exe, file, info, { ss: Math.max(0, sel[0].t - 0.5 / info.fps), t: sel.length / info.fps, crop: { x: x0, y: y0, w: cw, h: chh }, w: ow, h: oh, signal: o.signal }, (img, t) => {
        const r = byFrame.get(Math.round(t * info.fps));
        if (r) r.m = mirror(img, ow, oh, (r.x * K - x0) * sx, (r.y * K - y0) * sy, r.w * K * sx, o);
      });
    }
    const hit = findClap(rows, info.fps, o);
    return hit ? Object.assign(hit, { tracked: idx.length }) : null;
  }

  return { DEFAULTS, parseRef, Tracker, searchRGB, nccAt, resize, mirror, findClap, find };
});
