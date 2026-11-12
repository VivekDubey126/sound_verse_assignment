import { Request, Response, NextFunction } from 'express';
import { RateLimitError } from '../utils/errors';
import type { Plan } from '../types';

/**
 * In-memory sliding-window rate limiter.
 * Tracks requests per account for hourly and daily windows.
 *
 * For production: replace with Redis-backed sliding window.
 */

interface RateBucket {
  timestamps: number[];
}

const hourlyBuckets = new Map<string, RateBucket>();
const dailyBuckets = new Map<string, RateBucket>();

function cleanOlderThan(bucket: RateBucket, cutoff: number): void {
  // Binary search would be better, but linear scan is fine for our scale
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
    bucket.timestamps.shift();
  }
}

function getOrCreateBucket(map: Map<string, RateBucket>, key: string): RateBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    map.set(key, bucket);
  }
  return bucket;
}

/**
 * Rate limiting middleware. Must be applied AFTER apiKeyAuth
 * (needs req.auth to be set).
 *
 * Sets standard rate limit headers on every response.
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  try {
    if (!req.auth) {
      return next();
    }

    const accountId = req.auth.accountId;
    const plan: Plan = req.auth.plan;
    const now = Date.now();

    // ── Hourly check ──
    const hourBucket = getOrCreateBucket(hourlyBuckets, `${accountId}:hour`);
    cleanOlderThan(hourBucket, now - 3600_000);

    if (hourBucket.timestamps.length >= plan.requests_per_hour) {
      const oldestInWindow = hourBucket.timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + 3600_000 - now) / 1000);

      res.setHeader('X-RateLimit-Limit', String(plan.requests_per_hour));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + retryAfter * 1000) / 1000)));

      throw new RateLimitError(
        'hourly_rate_limit_exceeded',
        `Rate limit exceeded: ${plan.requests_per_hour} requests per hour`,
        retryAfter
      );
    }

    // ── Daily check ──
    const dayBucket = getOrCreateBucket(dailyBuckets, `${accountId}:day`);
    cleanOlderThan(dayBucket, now - 86400_000);

    if (dayBucket.timestamps.length >= plan.requests_per_day) {
      const oldestInWindow = dayBucket.timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + 86400_000 - now) / 1000);

      res.setHeader('X-RateLimit-Limit', String(plan.requests_per_day));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + retryAfter * 1000) / 1000)));

      throw new RateLimitError(
        'daily_rate_limit_exceeded',
        `Rate limit exceeded: ${plan.requests_per_day} requests per day`,
        retryAfter
      );
    }

    // Record this request
    hourBucket.timestamps.push(now);
    dayBucket.timestamps.push(now);

    // Set rate limit headers (use hourly as the primary)
    const hourRemaining = plan.requests_per_hour - hourBucket.timestamps.length;
    res.setHeader('X-RateLimit-Limit', String(plan.requests_per_hour));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, hourRemaining)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + 3600_000) / 1000)));

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Reset rate limit state (for testing).
 */
export function resetRateLimits(): void {
  hourlyBuckets.clear();
  dailyBuckets.clear();
}

