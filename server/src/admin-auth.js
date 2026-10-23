import crypto from 'node:crypto'
import { q } from './db.js'

const SESSION_TTL = 12 * 60 * 60 * 1000
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')

export function publicAdmin(account) {
  return { id: Number(account.id), username: account.username, nickname: account.nickname, role: account.role }
}

export async function createAdminSession(accountId) {
  const token = `admin_${crypto.randomBytes(32).toString('hex')}`
  const now = Date.now()
  await q.run('DELETE FROM admin_sessions WHERE expires_at <= ?', now)
  await q.run('INSERT INTO admin_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)', digest(token), accountId, now, now + SESSION_TTL)
  return token
}

export async function adminRequired(req, res, next) {
  const authorization = String(req.headers.authorization || '')
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!/^admin_[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: '请登录运营管理后台', code: 'ADMIN_SESSION_EXPIRED' })
  const hash = digest(token)
  const account = await q.get(`SELECT a.* FROM admin_sessions s JOIN admin_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.is_active = 1`, hash, Date.now())
  if (!account) return res.status(401).json({ error: '后台登录已过期，请重新登录', code: 'ADMIN_SESSION_EXPIRED' })
  req.admin = publicAdmin(account)
  req.adminSessionHash = hash
  next()
}
