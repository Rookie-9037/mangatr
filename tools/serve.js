/* Static file server for tools/preview.html.
 *
 * The preview must be served over http:// rather than opened from disk:
 * Tesseract spins up a Web Worker and Gemini rejects requests with a null
 * origin, both of which break under file://.
 *
 *   node tools/serve.js
 *   -> http://localhost:8123/tools/preview.html
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 8123;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

http
  .createServer((req, res) => {
    const requested = decodeURIComponent(req.url.split("?")[0]);
    const target = path.join(ROOT, path.normalize(requested));

    // Keep the server inside the repository.
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    fs.readFile(target, (error, data) => {
      if (error) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("bulunamadi");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log("MangaTR onizleme: http://localhost:" + PORT + "/tools/preview.html");
  });