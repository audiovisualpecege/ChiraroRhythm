/**
 * syncFaceWorker.js — Web Worker (módulo) da sincronização por imagem.
 * Um FaceLandmarker do MediaPipe (CPU) por recorte; mede a abertura da boca
 * (distância entre os lábios 13–14 ÷ altura do rosto 10–152).
 *
 * Mensagens:
 *   { type: "tiles", id, jpeg, tiles: [{ x, y, s }] }  → { id, faces: [{ cx, cy, fh }] } (px do quadro)
 *   { type: "frame", id, jpeg, k }                     → { id, open: [k valores ou null] }
 *     (jpeg com k recortes 320×320 empilhados na vertical)
 *
 * Armadilhas (medidas no CEP 12, 08/10/2026): worker de módulo não tem
 * importScripts → o loader do wasm é lido com fetch e avaliado aqui, e
 * self.ModuleFactory precisa existir ANTES de cada createFromOptions (a
 * biblioteca o apaga); detectForVideo exige tempo estritamente crescente.
 */
import { FilesetResolver, FaceLandmarker } from "../../vendor/mediapipe/vision_bundle.mjs";

const base = new URL("../../vendor/mediapipe/", self.location.href).href;
const SIZE = 320;
let files = null, loaderCode = null, imageLm = null;
const videoLms = [];
let clock = 0;

const ready = (async () => {
  files = await FilesetResolver.forVisionTasks(base + "wasm");
  loaderCode = await (await fetch(files.wasmLoaderPath)).text();
  self.importScripts = () => {};
})();

function make(mode, numFaces) {
  (0, eval)(loaderCode + "\n;self.ModuleFactory = ModuleFactory;");
  return FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: base + "face_landmarker.task", delegate: "CPU" },
    runningMode: mode,
    numFaces,
    outputFaceBlendshapes: false,
    minFaceDetectionConfidence: mode === "IMAGE" ? 0.5 : 0.3,
    minTrackingConfidence: 0.3,
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function tiles({ id, jpeg, tiles }) {
  if (!imageLm) imageLm = await make("IMAGE", 4);
  const blob = new Blob([jpeg], { type: "image/jpeg" });
  const faces = [];
  for (const t of tiles) {
    const bmp = await createImageBitmap(blob, t.x, t.y, t.s, t.s, { resizeWidth: SIZE, resizeHeight: SIZE });
    const r = imageLm.detect(bmp);
    bmp.close();
    for (const p of r.faceLandmarks) {
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      for (const q of p) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
      faces.push({ cx: t.x + ((x0 + x1) / 2) * t.s, cy: t.y + ((y0 + y1) / 2) * t.s, fh: (y1 - y0) * t.s });
    }
  }
  postMessage({ id, faces });
}

async function frame({ id, jpeg, k }) {
  while (videoLms.length < k) videoLms.push(await make("VIDEO", 1));
  const blob = new Blob([jpeg], { type: "image/jpeg" });
  clock += 34; // ms, sempre crescente para todos os detectores deste worker
  const open = [];
  for (let i = 0; i < k; i++) {
    const bmp = await createImageBitmap(blob, 0, i * SIZE, SIZE, SIZE);
    const r = videoLms[i].detectForVideo(bmp, clock);
    bmp.close();
    const p = r.faceLandmarks[0];
    open.push(p ? dist(p[13], p[14]) / Math.max(1e-6, dist(p[10], p[152])) : null);
  }
  postMessage({ id, open });
}

let queue = ready.then(() => postMessage({ ready: true }), (e) => postMessage({ ready: false, error: String((e && e.message) || e) }));
onmessage = (e) => {
  const m = e.data;
  queue = queue.then(() => (m.type === "tiles" ? tiles(m) : frame(m))).catch((err) => postMessage({ id: m.id, error: String((err && err.message) || err) }));
};
