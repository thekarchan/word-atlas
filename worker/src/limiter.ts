/**
 * Global request counter for the asset proxy.
 *
 * One instance, addressed by a fixed name, so every edge location increments
 * the same number. Cloudflare serialises requests per object, and the storage
 * transaction below makes the read-modify-write atomic: two concurrent requests
 * cannot both read 999,999 and both write 1,000,000.
 *
 * SQLite-backed because the Workers Free plan does not offer the KV backend.
 */

export interface LimiterEnv {
  MONTHLY_REQUEST_LIMIT?: string;
}

interface Counter {
  period: string;
  count: number;
}

export interface Usage {
  period: string;
  count: number;
  limit: number;
  remaining: number;
  allowed: boolean;
}

const DEFAULT_LIMIT = 1_000_000;
const KEY = "counter";

function periodOf(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class UsageLimiter {
  private state: DurableObjectState;
  private env: LimiterEnv;

  constructor(state: DurableObjectState, env: LimiterEnv) {
    this.state = state;
    this.env = env;
  }

  private limit(): number {
    const n = Number(this.env.MONTHLY_REQUEST_LIMIT);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = this.limit();

    if (url.pathname === "/usage") {
      return Response.json(await this.read(limit));
    }

    if (url.pathname === "/incr") {
      const raw = Number(url.searchParams.get("n") ?? "1");
      const n = Number.isFinite(raw) ? Math.min(1000, Math.max(1, Math.floor(raw))) : 1;
      return Response.json(await this.increment(n, limit));
    }

    return new Response("not found", { status: 404 });
  }

  /** Read-only view; never advances the period, so it cannot be used to reset. */
  private async read(limit: number): Promise<Usage> {
    const period = periodOf(Date.now());
    const stored = (await this.state.storage.get<Counter>(KEY)) ?? null;
    const count = stored && stored.period === period ? stored.count : 0;
    return {
      period,
      count,
      limit,
      remaining: Math.max(0, limit - count),
      allowed: count < limit,
    };
  }

  private async increment(n: number, limit: number): Promise<Usage> {
    const period = periodOf(Date.now());

    return this.state.storage.transaction(async (txn) => {
      const stored = (await txn.get<Counter>(KEY)) ?? null;
      const count = stored && stored.period === period ? stored.count : 0;

      if (count + n > limit) {
        return { period, count, limit, remaining: 0, allowed: false };
      }

      const next: Counter = { period, count: count + n };
      await txn.put(KEY, next);
      return {
        period,
        count: next.count,
        limit,
        remaining: Math.max(0, limit - next.count),
        allowed: true,
      };
    });
  }
}
