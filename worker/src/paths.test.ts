import assert from "node:assert/strict";
import { test } from "node:test";
import { contentTypeFor, secondsUntilNextPeriod, toObjectKey, utcPeriod } from "./paths";

test("accepts the keys the bucket actually holds", () => {
  assert.equal(toObjectKey("/illustrations/img/abandon.webp"), "illustrations/img/abandon.webp");
  assert.equal(toObjectKey("/illustrations/thumb/a-m.webp"), "illustrations/thumb/a-m.webp");
  assert.equal(toObjectKey("/audio/uk/abandon.mp3"), "audio/uk/abandon.mp3");
  assert.equal(toObjectKey("/audio/ex2/above-mentioned.mp3"), "audio/ex2/above-mentioned.mp3");
  assert.equal(toObjectKey("/brand/topic-education.webp"), "brand/topic-education.webp");
  assert.equal(toObjectKey("/sfx/amb-stars.mp3"), "sfx/amb-stars.mp3");
});

test("refuses traversal in every encoding we can think of", () => {
  assert.equal(toObjectKey("/../secret"), null);
  assert.equal(toObjectKey("/illustrations/../../etc/passwd"), null);
  assert.equal(toObjectKey("/%2e%2e/secret"), null);
  assert.equal(toObjectKey("/%2E%2E%2Fsecret"), null);
  // Double-encoded: decodes once to "%2e%2e", which then fails the charset check.
  assert.equal(toObjectKey("/%252e%252e/secret"), null);
  assert.equal(toObjectKey("/a\\..\\b"), null);
});

test("refuses paths that are not plain object keys", () => {
  assert.equal(toObjectKey("/"), null);
  assert.equal(toObjectKey(""), null);
  assert.equal(toObjectKey("illustrations/img/x.webp"), null); // no leading slash
  assert.equal(toObjectKey("/audio//uk/x.mp3"), null);
  assert.equal(toObjectKey("/audio/uk/"), null);
  assert.equal(toObjectKey("/audio/uk/x.mp3%00"), null);
  assert.equal(toObjectKey("/audio/uk/x y.mp3"), null);
  assert.equal(toObjectKey("/audio/uk/x.mp3?debug=1"), null);
  assert.equal(toObjectKey(`/${"a".repeat(600)}`), null);
  assert.equal(toObjectKey("/%zz"), null); // malformed escape
});

test("content type falls back to the extension", () => {
  assert.equal(contentTypeFor("a.webp", "image/webp"), "image/webp");
  assert.equal(contentTypeFor("a.webp", null), "image/webp");
  assert.equal(contentTypeFor("a.mp3", "application/octet-stream"), "audio/mpeg");
  assert.equal(contentTypeFor("a.json", undefined), "application/json; charset=utf-8");
  assert.equal(contentTypeFor("a.bin", null), "application/octet-stream");
});

test("period rolls over on the UTC month boundary", () => {
  assert.equal(utcPeriod(Date.UTC(2026, 0, 15)), "2026-01");
  assert.equal(utcPeriod(Date.UTC(2026, 9, 26, 23, 59)), "2026-10");
  assert.equal(utcPeriod(Date.UTC(2026, 10, 1, 0, 0)), "2026-11");
  // 2026-11-01T00:00Z exactly one second later is a different period
  assert.equal(utcPeriod(Date.UTC(2026, 9, 31, 23, 59, 59)), "2026-10");
});

test("retry-after counts down to the next UTC month", () => {
  const endOfOctober = Date.UTC(2026, 9, 31, 23, 59, 0);
  assert.equal(secondsUntilNextPeriod(endOfOctober), 60);
  assert.ok(secondsUntilNextPeriod(Date.UTC(2026, 9, 1)) > 2_000_000);
});
