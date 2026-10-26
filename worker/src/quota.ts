/**
 * The quota gate, kept free of runtime globals so its failure behaviour can be
 * tested without a Durable Object.
 */
import type { Usage } from "./limiter";
import { secondsUntilNextPeriod } from "./paths";

export type SpendResult = { ok: true; usage: Usage } | { ok: false; response: Response };

export interface SpendOptions {
  /** Charges one read and resolves the new usage. Expected to throw when the counter is unreachable. */
  charge: () => Promise<Usage>;
  /** Refuse traffic when the counter cannot be reached. */
  failClosed: boolean;
  now?: number;
}

/**
 * Charge one R2 read against the monthly budget.
 *
 * The default is to fail closed: a counter we cannot reach is a counter we
 * cannot trust, and serving unmetered reads is exactly how a runaway bill
 * starts. `failClosed: false` is a deliberate downgrade for debugging.
 */
export async function spend({ charge, failClosed, now = Date.now() }: SpendOptions): Promise<SpendResult> {
  let usage: Usage;

  try {
    usage = await charge();
  } catch (err) {
    console.error("limiter unavailable", String(err));
    if (failClosed) return { ok: false, response: unavailable() };
    return { ok: true, usage: { period: "unknown", count: 0, limit: 0, remaining: 0, allowed: true } };
  }

  if (!usage.allowed) return { ok: false, response: exhausted(usage, now) };
  return { ok: true, usage };
}

function unavailable(): Response {
  return new Response("quota service unavailable", {
    status: 503,
    headers: { "retry-after": "30", "cache-control": "no-store" },
  });
}

function exhausted(usage: Usage, now: number): Response {
  return new Response(
    JSON.stringify({ error: "monthly asset budget exhausted", period: usage.period, limit: usage.limit }),
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(secondsUntilNextPeriod(now)),
        "cache-control": "no-store",
      },
    },
  );
}
