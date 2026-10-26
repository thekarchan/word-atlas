import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "./limiter";
import { spend } from "./quota";

const allowed: Usage = { period: "2026-10", count: 4, limit: 10, remaining: 6, allowed: true };
const blocked: Usage = { period: "2026-10", count: 10, limit: 10, remaining: 0, allowed: false };

test("passes through when the counter has room", async () => {
  const result = await spend({ charge: async () => allowed, failClosed: true });
  assert.equal(result.ok, true);
});

test("returns 429 with a retry-after when the budget is spent", async () => {
  const now = Date.UTC(2026, 9, 31, 23, 59, 0);
  const result = await spend({ charge: async () => blocked, failClosed: true, now });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get("retry-after"), "60");
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  const body = await result.response.json();
  assert.equal(body.period, "2026-10");
});

test("fails closed when the counter is unreachable", async () => {
  const result = await spend({
    charge: async () => {
      throw new Error("do unavailable");
    },
    failClosed: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.response.status, 503);
});

test("only serves unmetered reads when explicitly told to", async () => {
  const result = await spend({
    charge: async () => {
      throw new Error("do unavailable");
    },
    failClosed: false,
  });
  assert.equal(result.ok, true);
});

test("a counter that returns a non-allowed payload never reaches R2", async () => {
  let charged = 0;
  const result = await spend({
    charge: async () => {
      charged++;
      return blocked;
    },
    failClosed: true,
  });
  assert.equal(charged, 1);
  assert.equal(result.ok, false);
});
