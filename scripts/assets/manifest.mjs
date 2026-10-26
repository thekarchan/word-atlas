#!/usr/bin/env node
/**
 * Inventory of the asset tree that is published to Cloudflare R2.
 *
 *   node scripts/assets/manifest.mjs              # summary by folder
 *   node scripts/assets/manifest.mjs --write      # also write assets/manifest.json
 *   node scripts/assets/manifest.mjs --check      # verify every file the dataset references exists
 *
 * Object keys are the paths themselves, so the public URL of a file is
 * `<ASSET_BASE>/<key>` — the same string the app builds in src/lib/assets.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ASSETS = path.join(root, "assets");

/** Files that describe the tree rather than belong to it. */
const META = new Set(["manifest.json", "README.md", ".DS_Store"]);

const CONTENT_TYPES = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".json": "application/json; charset=utf-8",
};

export const contentType = (key) => CONTENT_TYPES[path.extname(key).toLowerCase()] || "application/octet-stream";

/** Every publishable file under assets/, as { key, file, bytes }. */
export function scan(dir = ASSETS, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full, base, out);
    } else if (entry.isFile() && !META.has(entry.name)) {
      out.push({ key: path.relative(base, full).split(path.sep).join("/"), file: full, bytes: fs.statSync(full).size });
    }
  }
  return out;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function main() {
  const args = process.argv.slice(2);
  const items = scan();
  if (!items.length) {
    console.error(`No assets found in ${path.relative(root, ASSETS)}/.`);
    console.error("Run `npm run assets:pull` to restore the media from git history first.");
    process.exit(1);
  }

  const byFolder = {};
  for (const item of items) {
    const folder = item.key.includes("/") ? item.key.slice(0, item.key.lastIndexOf("/")) : "(root)";
    byFolder[folder] ??= { files: 0, bytes: 0 };
    byFolder[folder].files++;
    byFolder[folder].bytes += item.bytes;
  }
  const total = items.reduce((n, i) => n + i.bytes, 0);

  console.log(`${String(items.length).padStart(6)} files  ${mb(total).padStart(10)}  total`);
  for (const [folder, v] of Object.entries(byFolder).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`${String(v.files).padStart(6)} files  ${mb(v.bytes).padStart(10)}  ${folder}/`);
  }

  if (args.includes("--check")) {
    const index = JSON.parse(fs.readFileSync(path.join(root, "web/public/atlas/index.json"), "utf8"));
    const have = new Set(items.map((i) => i.key));
    const missing = [];
    const need = [
      [1, "illustrations/img", "webp"],
      [1, "illustrations/thumb", "webp"],
      [2, "audio/uk", "mp3"],
      [4, "audio/us", "mp3"],
      [8, "audio/ex", "mp3"],
      [16, "audio/ex2", "mp3"],
    ];
    for (const row of index.words) {
      const [id, , , , , , bits] = row;
      for (const [bit, folder, ext] of need) {
        if (!(bits & bit)) continue;
        const key = `${folder}/${id}.${ext}`;
        if (!have.has(key) && missing.length < 40) missing.push(key);
      }
    }
    if (missing.length) {
      console.error(`\n${missing.length}${missing.length >= 40 ? "+" : ""} referenced files are missing, e.g.:`);
      console.error(missing.slice(0, 10).join("\n"));
      process.exit(1);
    }
    console.log("\nEvery file the dataset references exists.");
  }

  if (args.includes("--write")) {
    const payload = {
      generated: new Date().toISOString(),
      count: items.length,
      bytes: total,
      items: items.map((i) => ({ key: i.key, bytes: i.bytes, sha256: sha256(i.file) })),
    };
    fs.writeFileSync(path.join(ASSETS, "manifest.json"), JSON.stringify(payload, null, 0));
    console.log(`\nwrote assets/manifest.json (${payload.count} entries)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
