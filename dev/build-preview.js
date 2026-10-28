// Gera dev/preview.html a partir de extension/index.html, com o Premiere simulado.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
let html = fs.readFileSync(path.join(root, "extension", "index.html"), "utf8");
html = html.replace(/(href|src)="(css|js|img)\//g, '$1="../extension/$2/');
html = html.replace('<script src="../extension/js/lib/CSInterface.js"></script>',
  '<script src="mock-cep.js"></script>\n  <script src="fixture-envelope.js"></script>\n  <script src="fixture-mics.js"></script>\n  <script src="../extension/js/lib/CSInterface.js"></script>');
html = html.replace('<script src="../extension/js/main.js"></script>', '<script src="mock-media.js"></script>\n  <script src="../extension/js/main.js"></script>');
html = html.replace("<body>", '<body style="max-width:420px;margin:0 auto;border-left:1px solid #2F2C3D;border-right:1px solid #2F2C3D;background:#070010">');
fs.writeFileSync(path.join(__dirname, "preview.html"), html);
console.log("dev/preview.html gerado");
