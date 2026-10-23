import crypto from 'node:crypto'
import { q } from './db.js'

let schemaReady
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = q.run(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
      rate_key TEXT PRIMARY KEY,
      window_started_at BIGINT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    )`)
  }
  return schemaReady
}

/** Shared database-backed throttles work across Node processes and survive restarts. */
export function authRateLimit({ limit, windowMs, key, countFailuresOnly = false }) {
  return async (req, res, next) => {
    try {
      await ensureSchema()
      const now = Date.now()
      const rateKey = crypto.createHash('sha256').update(String(key(req)).slice(0, 512)).digest('hex')
      const state = await q.get(
        `INSERT INTO auth_rate_limits (rate_key, window_started_at, count) VALUES (?, ?, 1)
         ON CONFLICT(rate_key) DO UPDATE SET
           count = CASE WHEN auth_rate_limits.window_started_at <= ? THEN 1 ELSE auth_rate_limits.count + 1 END,
           window_started_at = CASE WHEN auth_rate_limits.window_started_at <= ? THEN ? ELSE auth_rate_limits.window_started_at END
         RETURNING count, window_started_at AS windowStartedAt`,
        rateKey,
        now,
        now - windowMs,
        now - windowMs,
        now
      )
      const count = Number(state.count)
      const windowStartedAt = Number(state.windowStartedAt)
      if (count > limit) {
        const retryAfter = Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1000))
        res.set('Retry-After', String(retryAfter))
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
      }
      if (countFailuresOnly) {
        res.once('finish', () => {
          if (res.statusCode < 400) {
            void q.run(
              `UPDATE auth_rate_limits SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END
               WHERE rate_key = ? AND window_started_at = ?`,
              rateKey,
              windowStartedAt
            ).catch((error) => console.warn('[auth-limit] 成功请求计数回退失败:', error.message))
          }
        })
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  void ensureSchema()
    .then(() => q.run('DELETE FROM auth_rate_limits WHERE window_started_at < ?', cutoff))
    .catch((error) => console.warn('[auth-limit] 过期计数清理失败:', error.message))
}, 10 * 60 * 1000).unref()
