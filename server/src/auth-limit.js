/** Small process-local throttles for public authentication endpoints. */
const attempts = new Map()

export function authRateLimit({ limit, windowMs, key, countFailuresOnly = false }) {
  return (req, res, next) => {
    const now = Date.now()
    const id = key(req)
    let bucket = attempts.get(id)
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, count: 0 }
      attempts.set(id, bucket)
    }
    bucket.count += 1
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000))
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    }
    /* A successful login proves the credentials are valid and must not consume the
       brute-force budget. Otherwise normal multi-device sessions and the project's
       serial browser regression suites lock out seeded users after a handful of logins. */
    if (countFailuresOnly) {
      res.once('finish', () => {
        if (res.statusCode < 400) bucket.count = Math.max(0, bucket.count - 1)
      })
    }
    next()
  }
}

// Bound the map under scans of many unique usernames/IPs.
setInterval(() => {
  const now = Date.now()
  for (const [id, bucket] of attempts) {
    if (now - bucket.startedAt > 60 * 60 * 1000) attempts.delete(id)
  }
}, 10 * 60 * 1000).unref()
