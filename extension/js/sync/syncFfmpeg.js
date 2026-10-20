/**
 * syncFfmpeg.js — o ffmpeg da sincronização por imagem (Node, no painel).
 *
 *  - find(): acha um ffmpeg que decodifique H.264 e HEVC — primeiro o que o
 *    instalador do Rhythm copia (C:\ProgramData\Rhythm\ffmpeg), depois o PATH.
 *  - probe(): duração, fps, tamanho e início (start) do vídeo, lidos do
 *    cabeçalho que o ffmpeg imprime.
 *  - frames(): roda o ffmpeg e entrega cada quadro (JPEG) com o horário dele
 *    no arquivo (showinfo, -copyts) — sem supor quadro exato no -ss.
 *
 * O painel não decodifica HEVC 4:2:2 10 bits (Sony) nem lê MXF; o ffmpeg sim.
 */
(function (root, factory) {
  const api = factory();
  root.AESyncFfmpeg = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // na prévia do navegador (sem Node) o módulo carrega, mas find() diz que não há ffmpeg
  let cp = null, fs = null, path = null;
  try { cp = require("child_process"); fs = require("fs"); path = require("path"); } catch (e) {}
  const nodeOk = () => !!(cp && cp.spawnSync && fs && fs.existsSync && path);

  const RHYTHM_DIR = "C:\\ProgramData\\Rhythm\\ffmpeg";

  function run(exe, args, timeoutMs) {
    try {
      const r = cp.spawnSync(exe, args, { encoding: "utf8", timeout: timeoutMs || 15000, windowsHide: true, maxBuffer: 16 << 20 });
      if (r.error) return null;
      return (r.stdout || "") + (r.stderr || "");
    } catch (e) {
      return null;
    }
  }

  /** Confere um executável: versão e se decodifica h264 e hevc. */
  function check(exe) {
    if (!exe) return null;
    const ver = run(exe, ["-hide_banner", "-version"]);
    if (!ver || !/ffmpeg version/i.test(ver)) return null;
    const dec = run(exe, ["-hide_banner", "-decoders"]) || "";
    const has = (name) => new RegExp("^\\s*V[.A-Z]{5}\\s+" + name + "\\s", "m").test(dec);
    const version = (/ffmpeg version (\S+)/i.exec(ver) || [])[1] || "?";
    if (!has("h264") || !has("hevc")) return { ok: false, exe, version, reason: "este ffmpeg não decodifica H.264/HEVC" };
    return { ok: true, exe, version };
  }

  let found;
  /** { ok, exe, version } ou { ok:false, reason }. Guarda o resultado (reset: find(true)). */
  function find(force) {
    if (found && !force) return found;
    if (!nodeOk()) return (found = { ok: false, reason: "sem Node (prévia)" });
    const cands = [path.join(RHYTHM_DIR, "ffmpeg.exe")];
    const where = run("where.exe", ["ffmpeg"], 5000);
    if (where) for (const l of where.split(/\r?\n/)) if (/ffmpeg(\.exe)?$/i.test(l.trim())) cands.push(l.trim());
    let bad = null;
    for (const c of cands) {
      if (!fs.existsSync(c)) continue;
      const r = check(c);
      if (r && r.ok) return (found = r);
      if (r) bad = r;
    }
    return (found = bad || { ok: false, reason: "ffmpeg não encontrado — rode o instalador do Rhythm" });
  }

  /** Cabeçalho do 1º vídeo: { dur, fps, w, h, start } (s). */
  function probe(exe, file) {
    const out = run(exe, ["-hide_banner", "-i", file], 20000) || "";
    const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(out);
    const st = /start:\s*(-?[\d.]+)/.exec(out);
    const v = /Stream #\S+?(?:\[[^\]]*\])?(?:\([^)]*\))?: Video: (.*)/.exec(out);
    if (!d || !v) throw new Error("ffmpeg não achou vídeo em " + path.basename(file));
    const line = v[1];
    const wh = /, (\d{2,5})x(\d{2,5})/.exec(line);
    const fr = /([\d.]+) fps/.exec(line) || /([\d.]+) tbr/.exec(line);
    let fps = fr ? Number(fr[1]) : 0;
    // 29.97 / 59.94 / 23.98 vêm arredondados no texto
    for (const n of [24000 / 1001, 30000 / 1001, 60000 / 1001, 120000 / 1001]) if (Math.abs(fps - n) < 0.01) fps = n;
    return {
      dur: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
      start: st ? Number(st[1]) : 0,
      fps,
      w: wh ? Number(wh[1]) : 0,
      h: wh ? Number(wh[2]) : 0,
    };
  }

  /**
   * Filtro de vídeo para recortes quadrados empilhados (cada um vira size×size).
   * crops: [{ x, y, s }] em px do quadro original.
   */
  function cropFilter(crops, size) {
    if (!crops || !crops.length) return null;
    const parts = crops.map((c, i) => `[0:v]crop=${c.s}:${c.s}:${c.x}:${c.y},scale=${size}:${size}:flags=bilinear[c${i}]`);
    const stack = crops.map((_, i) => `[c${i}]`).join("") + (crops.length > 1 ? `vstack=inputs=${crops.length}` : "null");
    return parts.join(";") + ";" + stack + ",showinfo[out]";
  }

  /**
   * Roda o ffmpeg e chama onFrame(jpeg: Buffer, t: s no arquivo) para cada quadro.
   * opts: { ss, t, keyOnly, crops, size, still (só 1 quadro inteiro), signal: { cancelled }, flow: {} }
   * Retorna Promise com o nº de quadros.
   */
  function frames(exe, file, info, opts, onFrame) {
    const o = Object.assign({ size: 320 }, opts);
    // COM filtro de laço: sem ele (2.7.1, −12% no HEVC 4K) a boca do plano aberto da palestra caiu de
    // razão 1,76 para 1,21 e foi descartada (medido 14/10, rostos de ~100 px). Só a claquete (gray) dispensa.
    const args = ["-hide_banner", "-nostats", "-loglevel", "info"];
    if (o.keyOnly) args.push("-skip_frame", "nokey");
    if (o.ss != null) args.push("-ss", o.ss.toFixed(3));
    args.push("-copyts");
    if (o.t != null) args.push("-t", o.t.toFixed(3));
    args.push("-i", file, "-an", "-sn", "-dn");
    const fc = cropFilter(o.crops, o.size);
    if (fc) args.push("-filter_complex", fc, "-map", "[out]");
    else args.push("-vf", "showinfo");
    if (o.still) args.push("-frames:v", "1");
    args.push("-fps_mode", "passthrough", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "-");
    return new Promise((resolve, reject) => {
      const p = cp.spawn(exe, args, { windowsHide: true });
      const times = [];
      const queue = []; // JPEGs que chegaram antes do horário (showinfo vem pelo stderr)
      let errTail = "", sbuf = "";
      let buf = Buffer.alloc(0), scan = 0, n = 0, done = false;
      const flush = () => {
        while (queue.length && times.length) {
          const t = times.shift() - info.start;
          // onFrame devolve true = "estou cheio": pausa a leitura até flow.resume()
          if (onFrame(queue.shift(), t) === true && o.flow) {
            p.stdout.pause();
            o.flow.resume = () => p.stdout.resume();
          }
          n++;
        }
      };
      p.stderr.on("data", (d) => {
        sbuf += d.toString("latin1");
        let k;
        while ((k = sbuf.indexOf("\n")) >= 0) {
          const line = sbuf.slice(0, k);
          sbuf = sbuf.slice(k + 1);
          const m = /showinfo.*\bn:\s*\d+.*\bpts_time:\s*(-?[\d.]+)/.exec(line);
          if (m) times.push(Number(m[1]));
          else if (line.trim()) errTail = (errTail + "\n" + line).slice(-600);
        }
        flush();
      });
      p.stdout.on("data", (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        let s = 0;
        for (;;) {
          // procura o fim do JPEG (FFD9) a partir de onde parou
          let e = -1;
          for (let i = Math.max(s + 2, scan); i < buf.length - 1; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { e = i + 2; break; }
          if (e < 0) { scan = Math.max(s, buf.length - 1); break; }
          queue.push(buf.subarray(s, e));
          s = e;
          scan = s;
        }
        if (s) { buf = Buffer.from(buf.subarray(s)); scan -= s; }
        flush();
        if (o.signal && o.signal.cancelled && !done) { done = true; p.kill(); }
      });
      p.on("error", reject);
      p.on("close", (code) => {
        flush();
        if (o.signal && o.signal.cancelled) return reject(new Error("cancelado"));
        if (code && !n) return reject(new Error("ffmpeg: " + (errTail.trim().split("\n").pop() || "código " + code)));
        resolve(n);
      });
    });
  }

  /**
   * Quadros em cinza, reduzidos (claquete): onFrame(gray: Uint8Array w×h, t: s no arquivo).
   * opts: { t (s desde o início), w, signal }. Retorna Promise({ n, w, h }).
   */
  function gray(exe, file, info, opts, onFrame) {
    const o = Object.assign({ w: 480 }, opts);
    const w = o.w, h = Math.max(2, Math.round((w * info.h) / info.w / 2) * 2), size = w * h;
    const args = ["-hide_banner", "-nostats", "-loglevel", "info", "-skip_loop_filter", "all", "-copyts"];
    if (o.t != null) args.push("-t", o.t.toFixed(3));
    args.push("-i", file, "-an", "-sn", "-dn", "-vf", `scale=${w}:${h}:flags=area,format=gray,showinfo`,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-");
    return new Promise((resolve, reject) => {
      const p = cp.spawn(exe, args, { windowsHide: true });
      const times = [], queue = [];
      let errTail = "", sbuf = "", buf = Buffer.alloc(0), n = 0;
      const flush = () => {
        while (queue.length && times.length) { onFrame(queue.shift(), times.shift() - info.start); n++; }
      };
      p.stderr.on("data", (d) => {
        sbuf += d.toString("latin1");
        let k;
        while ((k = sbuf.indexOf("\n")) >= 0) {
          const line = sbuf.slice(0, k);
          sbuf = sbuf.slice(k + 1);
          const m = /showinfo.*\bn:\s*\d+.*\bpts_time:\s*(-?[\d.]+)/.exec(line);
          if (m) times.push(Number(m[1]));
          else if (line.trim()) errTail = (errTail + "\n" + line).slice(-600);
        }
        flush();
      });
      p.stdout.on("data", (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        let s = 0;
        while (buf.length - s >= size) { queue.push(new Uint8Array(buf.subarray(s, s + size))); s += size; }
        if (s) buf = Buffer.from(buf.subarray(s));
        flush();
        if (o.signal && o.signal.cancelled) p.kill();
      });
      p.on("error", reject);
      p.on("close", (code) => {
        flush();
        if (o.signal && o.signal.cancelled) return reject(new Error("cancelado"));
        if (code && !n) return reject(new Error("ffmpeg: " + (errTail.trim().split("\n").pop() || "código " + code)));
        resolve({ n, w, h });
      });
    });
  }

  /**
   * Quadros RGB (claquete por referência): onFrame(rgb: Uint8Array w×h×3, t: s no arquivo).
   * opts: { ss?, t?, w, h (redução) | crop: { x, y, w, h } (resolução original; com w/h, recorta e reduz), signal }.
   */
  function rgb(exe, file, info, opts, onFrame) {
    const o = opts || {};
    const w = o.w || o.crop.w, h = o.h || o.crop.h, size = w * h * 3;
    const args = ["-hide_banner", "-nostats", "-loglevel", "info"];
    if (o.fast) args.push("-skip_loop_filter", "all"); // só para seguir a claquete em imagem reduzida
    if (o.ss != null) args.push("-ss", o.ss.toFixed(4));
    args.push("-copyts");
    if (o.t != null) args.push("-t", o.t.toFixed(4));
    const scale = `scale=${w}:${h}:flags=area`;
    const vf = o.crop ? `crop=${o.crop.w}:${o.crop.h}:${o.crop.x}:${o.crop.y}${o.w ? "," + scale : ""},showinfo` : `${scale},showinfo`;
    args.push("-i", file, "-an", "-sn", "-dn", "-vf", vf, "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-");
    return new Promise((resolve, reject) => {
      const p = cp.spawn(exe, args, { windowsHide: true });
      const times = [], queue = [];
      let errTail = "", sbuf = "", buf = Buffer.alloc(0), n = 0;
      const flush = () => { while (queue.length && times.length) { onFrame(queue.shift(), times.shift() - info.start); n++; } };
      p.stderr.on("data", (d) => {
        sbuf += d.toString("latin1");
        let k;
        while ((k = sbuf.indexOf("\n")) >= 0) {
          const line = sbuf.slice(0, k);
          sbuf = sbuf.slice(k + 1);
          const m = /showinfo.*\bn:\s*\d+.*\bpts_time:\s*(-?[\d.]+)/.exec(line);
          if (m) times.push(Number(m[1]));
          else if (line.trim()) errTail = (errTail + "\n" + line).slice(-600);
        }
        flush();
      });
      p.stdout.on("data", (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        let s = 0;
        while (buf.length - s >= size) { queue.push(new Uint8Array(buf.subarray(s, s + size))); s += size; }
        if (s) buf = Buffer.from(buf.subarray(s));
        flush();
        if (o.signal && o.signal.cancelled) p.kill();
      });
      p.on("error", reject);
      p.on("close", (code) => {
        flush();
        if (o.signal && o.signal.cancelled) return reject(new Error("cancelado"));
        if (code && !n) return reject(new Error("ffmpeg: " + (errTail.trim().split("\n").pop() || "código " + code)));
        resolve({ n, w, h });
      });
    });
  }

  return { RHYTHM_DIR, find, check, probe, frames, gray, rgb, cropFilter };
});
