#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const webRoot = resolve(process.env.TTS_WEB_ROOT ?? join(projectRoot, "apps/web/dist"));
const apiOrigin = new URL(process.env.TTS_API_ORIGIN ?? "http://127.0.0.1:6701");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 6700);

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

function isolationHeaders() {
  return {
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
}

function proxy(req, res) {
  const upstream = httpRequest(
    {
      protocol: apiOrigin.protocol,
      hostname: apiOrigin.hostname,
      port: apiOrigin.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: apiOrigin.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "API_UNAVAILABLE", message: "TTS API is unavailable." } }));
  });
  req.pipe(upstream);
}

function staticFile(req, res) {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  let filePath = resolve(webRoot, relative || "index.html");
  if (!filePath.startsWith(`${webRoot}/`) && filePath !== webRoot) {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(webRoot, "index.html");
  if (!existsSync(filePath)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Web build is not available.");
    return;
  }
  const immutable = filePath.includes(`${join(webRoot, "assets")}/`);
  res.writeHead(200, {
    ...isolationHeaders(),
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/api/")) proxy(req, res);
  else staticFile(req, res);
});

server.listen(port, host, () => {
  console.log(`TTS web gateway listening at http://${host}:${port}`);
});
