import { isIP } from "node:net";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self' https://accounts.spotify.com",
  "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
  "script-src-attr 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: http: https:",
  "connect-src 'self' http: https: ws: wss:",
  "frame-src 'self' https://videodownloader.site https://open.spotify.com https://www.youtube.com https://www.youtube-nocookie.com https://inv.nadeko.net https://archive.org",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");

export function createFixedWindowLimiter({ windowMs = 60000, maxEntries = 50000, now = () => Date.now() } = {}) {
  const buckets = new Map();

  function consume(key, limit, customWindowMs = windowMs) {
    const timestamp = now();
    let entry = buckets.get(key);
    if (!entry || timestamp - entry.start >= customWindowMs) entry = { start: timestamp, count: 0, lastSeen: timestamp };
    entry.count += 1;
    entry.lastSeen = timestamp;
    buckets.delete(key);
    buckets.set(key, entry);
    while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
    return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), retryAfter: Math.max(1, Math.ceil((customWindowMs - (timestamp - entry.start)) / 1000)) };
  }

  function cleanup(maxAgeMs = windowMs * 2) {
    const cutoff = now() - maxAgeMs;
    for (const [key, entry] of buckets) if (entry.lastSeen < cutoff) buckets.delete(key);
    while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
  }

  return { consume, cleanup, get size() { return buckets.size; } };
}

export function getClientIp(request, trustProxy = false) {
  if (trustProxy) {
    const forwarded = String(request?.headers?.["x-forwarded-for"] || "")
      .split(",")
      .map(value => value.trim())
      .filter(value => isIP(value));
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return String(request?.socket?.remoteAddress || "unknown").slice(0, 100);
}

export function isSameOriginWebSocket(origin, host) {
  try {
    const parsed = new URL(String(origin || ""));
    return ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host.toLowerCase() === String(host || "").toLowerCase();
  } catch {
    return false;
  }
}

export function securityHeaderValues(isProduction = false) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
    "X-DNS-Prefetch-Control": "off",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-Download-Options": "noopen",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY
  };
  if (isProduction) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}
