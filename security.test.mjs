import test from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowLimiter, securityHeaderValues } from "./security.mjs";

test("fixed-window limiter allows requests up to the configured limit", () => {
  let time = 1000;
  const limiter = createFixedWindowLimiter({ now: () => time });
  assert.equal(limiter.consume("client-a", 2).allowed, true);
  assert.equal(limiter.consume("client-a", 2).allowed, true);
  const blocked = limiter.consume("client-a", 2);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfter, 60);
});

test("fixed-window limiter isolates keys and resets after its window", () => {
  let time = 1000;
  const limiter = createFixedWindowLimiter({ now: () => time });
  assert.equal(limiter.consume("client-a", 1).allowed, true);
  assert.equal(limiter.consume("client-b", 1).allowed, true);
  assert.equal(limiter.consume("client-a", 1).allowed, false);
  time += 60000;
  assert.equal(limiter.consume("client-a", 1).allowed, true);
});

test("limiter cleanup removes stale entries and respects its size bound", () => {
  let time = 1000;
  const limiter = createFixedWindowLimiter({ now: () => time, maxEntries: 2 });
  limiter.consume("a", 10);
  limiter.consume("b", 10);
  limiter.consume("c", 10);
  assert.equal(limiter.size, 2);
  time += 200000;
  limiter.cleanup();
  assert.equal(limiter.size, 0);
});

test("production security headers include HSTS while local headers do not", () => {
  const local = securityHeaderValues(false);
  const production = securityHeaderValues(true);
  assert.equal(local["X-Content-Type-Options"], "nosniff");
  assert.equal(local["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal("Strict-Transport-Security" in local, false);
  assert.equal(production["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
});
