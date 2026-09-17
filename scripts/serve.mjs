// Serve this folder over http with CORS, the way a plugin author's dev server would: node scripts/serve.mjs . 3131
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
const root = process.argv[2];
const port = Number(process.argv[3] ?? 3131);
const types = { ".json": "application/json", ".js": "text/javascript", ".ts": "text/typescript", ".svg": "image/svg+xml", ".md": "text/markdown" };
createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let path = join(root, decodeURIComponent(url.pathname));
  try { if (statSync(path).isDirectory()) path = join(path, "plugin.json"); } catch { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }); res.end(); return; }
  try {
    const body = readFileSync(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }); res.end(); }
}).listen(port, () => console.log(`serving ${root} on ${port}`));
