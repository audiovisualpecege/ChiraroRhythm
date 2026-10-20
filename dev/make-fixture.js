// Gera dev/fixture-envelope.js (envelope real de 1 ms de um vídeo) para a prévia da UI.
// Uso: node dev/make-fixture.js caminho\do\video.mp4
const path = require("path");
const base = path.join(__dirname, "..", "extension", "js") + path.sep;
const C = require(base + "audio/containers.js");
const L = require(base + "audio/levels.js");
const file = process.argv[2];
if (!file) { console.error("uso: node dev/make-fixture.js <vídeo>"); process.exit(1); }
(async () => {
  const m = C.openMedia(file);
  const env = await L.mediaEnvelope(m, 0, m.info.durationSec, null);
  m.src.close();
  const b64 = Buffer.from(env.ms.buffer).toString("base64");
  require("fs").writeFileSync(path.join(__dirname, "fixture-envelope.js"),
    `// Envelope real (1 ms) de ${path.basename(file)}, gerado por dev/make-fixture.js\nwindow.__FIXTURE__ = { startSec: ${env.startSec}, durationSec: ${m.info.durationSec}, b64: "${b64}" };\n`);
  console.log("ok", env.ms.length);
})();
