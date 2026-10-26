/**
 * Asset addressing.
 *
 * Two very different things live behind two different origins:
 *
 *  - `assets.*` (Cloudflare R2) — illustrations, audio, brand art, UI sound.
 *    Hundreds of MB, immutable once published, addressed by content path.
 *  - `APP_BASE` (Cloudflare Pages) — the shell and the JSON dataset. Deployed
 *    atomically with the code, so it must never be cached across versions.
 *
 * Everything that points at a file goes through here; nothing else should
 * touch `import.meta.env.BASE_URL` for media.
 */

/** Media origin. Override with VITE_ASSET_BASE (see web/.env.example). */
const RAW = (import.meta.env.VITE_ASSET_BASE ?? "").trim();

export const ASSET_BASE = (RAW || "https://assets.hellokar.org").replace(/\/+$/, "");

/** Absolute URL for a file on the asset origin, e.g. asset("brand/hero.webp"). */
export const asset = (path: string): string => `${ASSET_BASE}/${path.replace(/^\/+/, "")}`;

/** True when media is served from a different origin (affects caching rules). */
export const ASSET_IS_REMOTE = /^https?:\/\//i.test(ASSET_BASE);

/** Root of the app itself, honouring a sub-path deploy (ATLAS_BASE=/words/). */
export const APP_BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** Absolute URL for a dataset file shipped with the app, e.g. data("index.json"). */
export const dataUrl = (path: string): string => `${APP_BASE}/atlas/${path.replace(/^\/+/, "")}`;
