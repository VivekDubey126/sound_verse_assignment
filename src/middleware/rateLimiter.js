const { RateLimitError } = require('../utils/errors');

const hourlyBuckets = new Map();
const dailyBuckets = new Map();

function cleanOlderThan(bucket, cutoff) {
  while (bucket.length > 0 && bucket[0] < cutoff) {
    bucket.shift();
  }
}

function rateLimiter(req, res, next) {
  if (!req.auth) return next();

  const accountId = req.auth.accountId;
  const plan = req.auth.plan;
  const now = Date.now();

  let hourBucket = hourlyBuckets.get(accountId);
  if (!hourBucket) {
    hourBucket = [];
    hourlyBuckets.set(accountId, hourBucket);
  }
  cleanOlderThan(hourBucket, now - 3600_000);

  if (hourBucket.length >= plan.requests_per_hour) {
    const retryAfter = Math.ceil((hourBucket[0] + 3600_000 - now) / 1000);
    res.setHeader('X-RateLimit-Limit', String(plan.requests_per_hour));
    res.setHeader('X-RateLimit-Remaining', '0');
    throw new RateLimitError('hourly_rate_limit_exceeded', `Rate limit exceeded: ${plan.requests_per_hour}/hr`, retryAfter);
  }

  let dayBucket = dailyBuckets.get(accountId);
  if (!dayBucket) {
    dayBucket = [];
    dailyBuckets.set(accountId, dayBucket);
  }
  cleanOlderThan(dayBucket, now - 86400_000);

  if (dayBucket.length >= plan.requests_per_day) {
    const retryAfter = Math.ceil((dayBucket[0] + 86400_000 - now) / 1000);
    res.setHeader('X-RateLimit-Limit', String(plan.requests_per_day));
    res.setHeader('X-RateLimit-Remaining', '0');
    throw new RateLimitError('daily_rate_limit_exceeded', `Rate limit exceeded: ${plan.requests_per_day}/day`, retryAfter);
  }

  hourBucket.push(now);
  dayBucket.push(now);

  res.setHeader('X-RateLimit-Limit', String(plan.requests_per_hour));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, plan.requests_per_hour - hourBucket.length)));

  next();
}

function resetRateLimits() {
  hourlyBuckets.clear();
  dailyBuckets.clear();
}

module.exports = { rateLimiter, resetRateLimits };

