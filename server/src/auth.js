/**
 * 认证：密码哈希（node:crypto scrypt，零依赖）+ JWT
 */
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { q } from './db.js'

const SECRET = process.env.JWT_SECRET || 'chatly-dev-secret-change-me'
const TTL = process.env.JWT_TTL || '7d'

/* ---------- 密码 ---------- */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex')
  return `scrypt$${salt}$${derived}`
}

export function verifyPassword(plain, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false
  const [, salt, hash] = stored.split('$')
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'))
  } catch {
    return false
  }
}

/* ---------- JWT ---------- */
export function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, SECRET, { expiresIn: TTL })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET)
  } catch {
    return null
  }
}

/* ---------- 中间件 ---------- */
export function authRequired(req, res, next) {
  const raw = req.headers.authorization || ''
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : req.query.token
  if (!token) return res.status(401).json({ error: 'unauthorized', message: '缺少 token' })

  const payload = verifyToken(token)
  if (!payload) return res.status(401).json({ error: 'unauthorized', message: 'token 无效或已过期' })

  const user = q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, payload.sub)
  if (!user) return res.status(401).json({ error: 'unauthorized', message: '用户不存在' })

  req.user = user
  next()
}

/* ---------- 用户出参（不含密码） ---------- */
/** 公开字段清单 —— 只在这一处维护，避免各路由 SELECT 漏字段导致资料悄悄丢 */
export const USER_COLS =
  'id, username, nickname, avatar, bio, gender, birthday, region, tags, ' +
  'city, city_lat, city_lng, city_public'

/** tags 在 DB 里是 JSON 文本；解析失败一律当空数组，不让脏数据把接口打挂 */
export function parseTags(v) {
  if (!v) return []
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
  try {
    const out = JSON.parse(v)
    return Array.isArray(out) ? out.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function publicUser(row) {
  if (!row) return null
  /* 位置相关的三个字段**必须在这里做闸门**，不能指望调用方自觉：
     `cityPublic = 0` 时连坐标都不出现在响应里。
     ⚠️ 只把 `cityPublic` 置 false 而照旧返回坐标是没用的 —— 前端抓包就知道你在哪。 */
  const cityPublic = !!Number(row.city_public)
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    avatar: row.avatar,
    bio: row.bio,
    gender: row.gender || null,
    birthday: row.birthday || null,
    region: row.region || null,
    tags: parseTags(row.tags),
    city: row.city || null,
    cityPublic,
    ...(cityPublic && Number.isFinite(row.city_lat) && Number.isFinite(row.city_lng)
      ? { cityLat: row.city_lat, cityLng: row.city_lng }
      : {}),
  }
}
