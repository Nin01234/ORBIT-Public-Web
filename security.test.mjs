import test from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowLimiter, getClientIp, isSameOriginWebSocket, securityHeaderValues } from "./security.mjs";

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
  limiter.consume("a", 10); limiter.consume("b", 10); limiter.consume("c", 10);
  assert.equal(limiter.size, 2);
  time += 200000;
  limiter.cleanup();
  assert.equal(limiter.size, 0);
});

test("client IP uses the last valid forwarded address only behind the trusted proxy", () => {
  const request = { headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.23, 192.0.2.7" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(getClientIp(request, true), "192.0.2.7");
  assert.equal(getClientIp(request, false), "127.0.0.1");
  assert.equal(getClientIp({ headers: { "x-forwarded-for": "attacker-value" }, socket: { remoteAddress: "10.0.0.4" } }, true), "10.0.0.4");
});

test("WebSocket upgrades require an exact same-origin host", () => {
  assert.equal(isSameOriginWebSocket("https://orbit.example.com", "orbit.example.com"), true);
  assert.equal(isSameOriginWebSocket("http://127.0.0.1:51731", "127.0.0.1:51731"), true);
  assert.equal(isSameOriginWebSocket("https://evil.example", "orbit.example.com"), false);
  assert.equal(isSameOriginWebSocket("", "orbit.example.com"), false);
});

test("security headers include a restrictive CSP and HSTS only in production", () => {
  const local = securityHeaderValues(false), production = securityHeaderValues(true);
  assert.equal(local["X-Content-Type-Options"], "nosniff");
  assert.equal(local["Cross-Origin-Resource-Policy"], "same-origin");
  assert.match(local["Content-Security-Policy"], /default-src 'self'/);
  assert.match(local["Content-Security-Policy"], /object-src 'none'/);
  assert.match(local["Content-Security-Policy"], /frame-ancestors 'self'/);
  assert.match(local["Content-Security-Policy"], /script-src[^;]*https:\/\/www\.youtube\.com/);
  assert.doesNotMatch(local["Content-Security-Policy"], /unsafe-eval/);
  assert.equal("Strict-Transport-Security" in local, false);
  assert.equal(production["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
});
