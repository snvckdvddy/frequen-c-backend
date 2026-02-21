/**
 * Server-Side Rate Limiter — Token Bucket per IP
 *
 * Express middleware that limits requests per IP address.
 * Uses a sliding-window token bucket: each IP gets `max` tokens,
 * refilled at `refillRate` tokens per `windowMs`.
 *
 * Separate limiters for different route groups:
 * - auth:    strict (prevent brute-force)
 * - api:     moderate (general endpoints)
 * - search:  lenient (users search rapidly)
 */

import { Request, Response, NextFunction } from 'express';

interface BucketConfig {
  /** Max tokens (burst capacity) */
  max: number;
  /** Window in ms for full refill */
  windowMs: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets: Record<string, Record<string, Bucket>> = {};

function getClientIP(req: Request): string {
  // Trust X-Forwarded-For from reverse proxy, fallback to socket
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function refillBucket(bucket: Bucket, config: BucketConfig): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  const refillAmount = (elapsed / config.windowMs) * config.max;
  bucket.tokens = Math.min(config.max, bucket.tokens + refillAmount);
  bucket.lastRefill = now;
}

export function createRateLimiter(name: string, config: BucketConfig) {
  if (!buckets[name]) buckets[name] = {};

  return (req: Request, res: Response, next: NextFunction): void => {
    // Bypass rate limiting in test environment
    if (process.env.NODE_ENV === 'test') { next(); return; }

    const ip = getClientIP(req);

    if (!buckets[name][ip]) {
      buckets[name][ip] = { tokens: config.max, lastRefill: Date.now() };
    }

    const bucket = buckets[name][ip];
    refillBucket(bucket, config);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      // Set rate limit headers (standard draft)
      res.setHeader('X-RateLimit-Limit', config.max);
      res.setHeader('X-RateLimit-Remaining', Math.floor(bucket.tokens));
      next();
    } else {
      const retryAfterMs = ((1 - bucket.tokens) / config.max) * config.windowMs;
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      res.setHeader('X-RateLimit-Limit', config.max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.status(429).json({ message: 'Too many requests, slow down' });
    }
  };
}

// ─── Prebuilt Limiters ─────────────────────────────────────

/** Auth routes: 10 requests per 15 minutes (brute-force protection) */
export const authLimiter = createRateLimiter('auth', {
  max: 10,
  windowMs: 15 * 60 * 1000,
});

/** General API: 100 requests per minute */
export const apiLimiter = createRateLimiter('api', {
  max: 100,
  windowMs: 60 * 1000,
});

/** Search: 30 requests per minute (users type fast) */
export const searchLimiter = createRateLimiter('search', {
  max: 30,
  windowMs: 60 * 1000,
});

// ─── Cleanup stale buckets every 10 minutes ────────────────

setInterval(() => {
  const staleThreshold = 30 * 60 * 1000; // 30 min
  const now = Date.now();
  for (const group of Object.keys(buckets)) {
    for (const ip of Object.keys(buckets[group])) {
      if (now - buckets[group][ip].lastRefill > staleThreshold) {
        delete buckets[group][ip];
      }
    }
  }
}, 10 * 60 * 1000);
