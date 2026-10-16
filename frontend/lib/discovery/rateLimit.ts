/**
 * Lightweight in-memory rate limiter for discovery API endpoints.
 */
interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateLimitBucket>();

export function checkRateLimit(
  clientIp: string,
  limit: number = 60,
  windowSeconds: number = 60
): { allowed: boolean; remaining: number; reset: number } {
  const now = Math.floor(Date.now() / 1000);
  const existing = ipBuckets.get(clientIp);

  if (!existing || now >= existing.resetAt) {
    ipBuckets.set(clientIp, {
      count: 1,
      resetAt: now + windowSeconds,
    });
    return {
      allowed: true,
      remaining: limit - 1,
      reset: now + windowSeconds,
    };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      reset: existing.resetAt,
    };
  }

  existing.count += 1;
  ipBuckets.set(clientIp, existing);

  return {
    allowed: true,
    remaining: limit - existing.count,
    reset: existing.resetAt,
  };
}
