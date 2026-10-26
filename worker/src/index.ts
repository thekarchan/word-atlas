/**
 * Private asset proxy for word-atlas.
 *
 *   assets.hellokar.org → this Worker → R2 (bucket stays private)
 *
 * Two jobs:
 *   1. Serve illustrations and audio out of a bucket that has no public URL.
 *   2. Stop serving them once the monthly R2 read budget is spent, so a crawler
 *      cannot quietly run up Class B charges.
 *
 * Requests that hit the edge cache never reach the counter: a cache hit costs
 * nothing on R2, so counting it would burn the budget on traffic that is free.
 */
import { UsageLimiter, type Usage } from "./limiter";
import { contentTypeFor, toObjectKey } from "./paths";
import { spend } from "./quota";

export { UsageLimiter };

export interface Env {
  ASSETS: R2Bucket;
  LIMITER: DurableObjectNamespace;
  MONTHLY_REQUEST_LIMIT?: string;
  ALLOWED_ORIGIN?: string;
  /** "false" serves assets even when the counter is unavailable. Default: fail closed. */
  FAIL_CLOSED?: string;
  ADMIN_TOKEN?: string;
}

const DEFAULT_ORIGIN = "https://words.hellokar.org";
const ONE_YEAR = "public, max-age=31536000, immutable";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Phase timings, surfaced as Server-Timing so a slow response can be
    // attributed to the counter, the bucket, or the network in front of us.
    const marks: Record<string, number> = {};
    let last = Date.now();
    const lap = (name: string) => {
      const now = Date.now();
      marks[name] = now - last;
      last = now;
    };

    // Nothing but reads. No PUT/POST/DELETE, and no OPTIONS preflight — the app
    // only ever makes simple GETs, so a preflight means someone else is probing.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/__usage") return adminUsage(request, env);

    const key = toObjectKey(url.pathname);
    if (!key) return notFound(env);

    const origin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const ranged = request.headers.has("range");
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/${key}`, { method: "GET" });

    // Range requests skip the cache: a partial response must not be stored as
    // if it were the whole object.
    if (!ranged) {
      const hit = await cache.match(cacheKey);
      lap("cache");
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set("server-timing", timing(marks));
        return request.method === "HEAD" ? new Response(null, { headers }) : new Response(hit.body, { headers });
      }
    }

    const gate = await spend({
      charge: () => chargeOne(env),
      failClosed: (env.FAIL_CLOSED ?? "true").toLowerCase() !== "false",
    });
    lap("quota");
    if (!gate.ok) return gate.response;

    try {
      if (request.method === "HEAD") {
        const head = await env.ASSETS.head(key);
        lap("r2");
        if (!head) return notFound(env);
        const headers = assetHeaders(head, key, origin);
        headers.set("server-timing", timing(marks));
        return new Response(null, { headers });
      }

      if (ranged) {
        const head = await env.ASSETS.head(key);
        if (!head) return notFound(env);
        const range = parseRange(request.headers.get("range")!, head.size);
        if (!range) {
          return new Response("range not satisfiable", {
            status: 416,
            headers: { "content-range": `bytes */${head.size}`, "cache-control": "no-store" },
          });
        }
        const part = await env.ASSETS.get(key, { range: { offset: range.start, length: range.length } });
        lap("r2");
        if (!part) return notFound(env);
        const headers = assetHeaders(head, key, origin);
        headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
        headers.set("content-length", String(range.length));
        headers.set("cache-control", "public, max-age=3600");
        headers.set("server-timing", timing(marks));
        return new Response(part.body, { status: 206, headers });
      }

      const object = await env.ASSETS.get(key);
      lap("r2");
      if (!object) return notFound(env);

      const headers = assetHeaders(object, key, origin);
      headers.set("server-timing", timing(marks));
      const response = new Response(object.body, { status: 200, headers });
      ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
      return response;
    } catch (err) {
      // R2 failures should look like an outage, not like a missing file.
      console.error("r2 read failed", key, String(err));
      return new Response("asset backend unavailable", {
        status: 503,
        headers: { "retry-after": "30", "cache-control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<Env>;

/** `cache;dur=3, quota;dur=41, r2;dur=88` */
function timing(marks: Record<string, number>): string {
  return Object.entries(marks)
    .map(([name, ms]) => `${name};dur=${ms}`)
    .join(", ");
}

function assetHeaders(object: R2Object, key: string, origin: string): Headers {
  const headers = new Headers();
  headers.set("content-type", contentTypeFor(key, object.httpMetadata?.contentType));
  headers.set("cache-control", ONE_YEAR);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "Content-Length, Content-Range, ETag");
  if (object.size) headers.set("content-length", String(object.size));
  return headers;
}

/**
 * Charge one read to the single global counter and return the new usage.
 * Throws when the Durable Object cannot be reached; `spend` decides what that
 * means (by default: refuse).
 */
async function chargeOne(env: Env): Promise<Usage> {
  const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
  const res = await stub.fetch("https://limiter/incr?n=1");
  if (!res.ok) throw new Error(`limiter ${res.status}`);
  return (await res.json()) as Usage;
}

/** `bytes=start-end`, clamped to the object. Multi-range requests are refused. */
function parseRange(header: string, size: number): { start: number; end: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end, length: end - start + 1 };
}

function notFound(env: Env): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": env.ALLOWED_ORIGIN || DEFAULT_ORIGIN },
  });
}

/**
 * Operator-only usage readout. Wrong or missing token returns 404, not 401, so
 * the endpoint does not advertise that it exists.
 */
async function adminUsage(request: Request, env: Env): Promise<Response> {
  const token = env.ADMIN_TOKEN;
  if (!token) return notFound(env);
  if (request.headers.get("authorization") !== `Bearer ${token}`) return notFound(env);

  try {
    const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
    const res = await stub.fetch("https://limiter/usage");
    return new Response(await res.text(), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
