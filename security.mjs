export function createFixedWindowLimiter({ windowMs = 60000, maxEntries = 50000, now = () => Date.now() } = {}) {
  const buckets = new Map();

  function consume(key, limit, customWindowMs = windowMs) {
    const timestamp = now();
    let entry = buckets.get(key);
    if (!entry || timestamp - entry.start >= customWindowMs) {
      entry = { start: timestamp, count: 0, lastSeen: timestamp };
    }
    entry.count += 1;
    entry.lastSeen = timestamp;
    buckets.delete(key);
    buckets.set(key, entry);
    while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
    return {
      allowed: entry.count <= limit,
      remaining: Math.max(0, limit - entry.count),
      retryAfter: Math.max(1, Math.ceil((customWindowMs - (timestamp - entry.start)) / 1000))
    };
  }

  function cleanup(maxAgeMs = windowMs * 2) {
    const cutoff = now() - maxAgeMs;
    for (const [key, entry] of buckets) {
      if (entry.lastSeen < cutoff) buckets.delete(key);
    }
    while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
  }

  return { consume, cleanup, get size() { return buckets.size; } };
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
    "Origin-Agent-Cluster": "?1"
  };
  if (isProduction) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}
