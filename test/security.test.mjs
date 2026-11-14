import test from "node:test";
import assert from "node:assert/strict";
import { createFixedWindowLimiter, getClientIp, isSameOriginWebSocket, securityHeaderValues } from "../security.mjs";

test("security headers include baseline browser protections",()=>{
  const headers=securityHeaderValues(false);
  assert.equal(headers["X-Content-Type-Options"],"nosniff");
  assert.equal(headers["X-Frame-Options"],"SAMEORIGIN");
  assert.equal(headers["Referrer-Policy"],"strict-origin-when-cross-origin");
  assert.match(headers["Content-Security-Policy"],/object-src 'none'/);
  assert.equal(headers["Strict-Transport-Security"],undefined);
});

test("production security headers enable HSTS",()=>{
  assert.equal(securityHeaderValues(true)["Strict-Transport-Security"],"max-age=31536000; includeSubDomains");
});

test("fixed-window limiter enforces limits and resets after the window",()=>{
  let now=1000;
  const limiter=createFixedWindowLimiter({windowMs:1000,now:()=>now});
  assert.deepEqual(limiter.consume("visitor",2),{allowed:true,remaining:1,retryAfter:1});
  assert.equal(limiter.consume("visitor",2).allowed,true);
  assert.equal(limiter.consume("visitor",2).allowed,false);
  now=2000;
  assert.equal(limiter.consume("visitor",2).allowed,true);
});

test("fixed-window limiter bounds the number of tracked keys",()=>{
  const limiter=createFixedWindowLimiter({maxEntries:2,now:()=>1000});
  limiter.consume("one",10);
  limiter.consume("two",10);
  limiter.consume("three",10);
  assert.equal(limiter.size,2);
});

test("trusted proxy IP selection ignores invalid forwarded entries",()=>{
  const request={headers:{"x-forwarded-for":"not-an-ip, 203.0.113.10, 198.51.100.20"},socket:{remoteAddress:"127.0.0.1"}};
  assert.equal(getClientIp(request,true),"198.51.100.20");
  assert.equal(getClientIp(request,false),"127.0.0.1");
});

test("WebSocket origin validation accepts only the matching HTTP(S) host",()=>{
  assert.equal(isSameOriginWebSocket("https://orbit.example.com","orbit.example.com"),true);
  assert.equal(isSameOriginWebSocket("http://ORBIT.example.com","orbit.example.com"),true);
  assert.equal(isSameOriginWebSocket("https://evil.example","orbit.example.com"),false);
  assert.equal(isSameOriginWebSocket("file://orbit.example.com","orbit.example.com"),false);
  assert.equal(isSameOriginWebSocket("","orbit.example.com"),false);
});
