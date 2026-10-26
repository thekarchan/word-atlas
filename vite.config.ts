import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Local-only content is never copied into dist or the public archive.
function localMedia(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const route = (req.url || "").split("?")[0];
  const root = path.join(ROOT, ".local");
  if (route === "/local/catalog.json") {
    const file = path.join(root, "catalog.json");
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(file).pipe(res);
    return;
  }
  const match = route.match(/^\/local\/media\/(image|uk|us|sentence)\/(\d{1,5})$/);
  if (!match) {
    next();
    return;
  }
  try {
    const map = JSON.parse(fs.readFileSync(path.join(root, "media-map.json"), "utf8"));
    const stored = map[match[2]]?.[match[1]];
    const file =
      typeof stored === "string"
        ? path.isAbsolute(stored)
          ? stored
          : path.resolve(root, stored)
        : undefined;
    if (!file || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const types: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
    };
    res.setHeader("Content-Type", types[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    const size = fs.statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const r = range.match(/^bytes=(\d+)-(\d*)$/);
      const start = r ? Number(r[1]) : -1;
      const end = r && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (start < 0 || start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", end - start + 1);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", size);
      fs.createReadStream(file).pipe(res);
    }
  } catch {
    res.statusCode = 404;
    res.end();
  }
}

/**
 * Serve `assets/` at /assets/ in dev, so `VITE_ASSET_BASE=/assets` works fully
 * offline. In production the same tree is published to Cloudflare R2.
 */
function localAssets(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const route = decodeURIComponent((req.url || "").split("?")[0]);
  if (!route.startsWith("/assets/")) {
    next();
    return;
  }
  const file = path.join(ROOT, route);
  if (!file.startsWith(path.join(ROOT, "assets")) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    next();
    return;
  }
  const types: Record<string, string> = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".json": "application/json; charset=utf-8",
  };
  res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Accept-Ranges", "bytes");
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const r = range.match(/^bytes=(\d+)-(\d*)$/);
    const start = r ? Number(r[1]) : -1;
    const end = r && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    if (start < 0 || start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.setHeader("Content-Length", size);
  fs.createReadStream(file).pipe(res);
}

export default defineConfig({
  // The React app lives in web/; media lives in assets/ and is served from R2.
  root: path.join(ROOT, "web"),
  // Read .env / .env.local from the repo root, not from web/.
  envDir: ROOT,
  // Deploy under a sub-path with ATLAS_BASE=/words/ npm run build
  base: process.env.ATLAS_BASE || "/",
  publicDir: path.join(ROOT, "web", "public"),
  plugins: [
    react(),
    {
      name: "private-local-library",
      configureServer(server) {
        server.middlewares.use(localAssets);
        server.middlewares.use(localMedia);
      },
      configurePreviewServer(server) {
        server.middlewares.use(localAssets);
        server.middlewares.use(localMedia);
      },
    },
  ],
  server: { port: 5188, strictPort: true },
  preview: { port: 5188, strictPort: true },
  build: {
    outDir: path.join(ROOT, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
  },
});
