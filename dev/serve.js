// Servidor estático mínimo para abrir dev/preview.html no navegador: node dev/serve.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".otf": "font/otf", ".ttf": "font/ttf" };
const port = Number(process.env.PORT || 5178);
http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(root, url === "/" ? "dev/preview.html" : url);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("not found");
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
