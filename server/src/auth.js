/**
 * 认证：密码哈希（node:crypto scrypt，零依赖）+ JWT
 */
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { q } from './db.js'

const configuredSecret = process.env.JWT_SECRET
if (process.env.NODE_ENV === 'production' && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error('生产环境必须配置至少 32 个字符的 JWT_SECRET')
}
const SECRET = configuredSecret || 'chatly-dev-secret-change-me'
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
export function signToken(user, sessionId) {
  return jwt.sign({ sub: user.id, username: user.username, sid: sessionId }, SECRET, { expiresIn: TTL })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET)
  } catch {
    return null
  }
}

/* ---------- 中间件 ---------- */
/**
 * ⚠️ 是 **async** 的：查用户要 await（PG 驱动下 q.get 是真的异步）。
 *    Express 5 会自动把返回的 Promise 的 reject 转给错误中间件 ——
 *    所以这里不写 try/catch 也不会变成「未处理的 rejection」，而是走全局 500。
 */
export async function authRequired(req, res, next) {
  const raw = req.headers.authorization || ''
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : req.query.token
  if (!token) return res.status(401).json({ error: 'unauthorized', message: '缺少 token' })

  const payload = verifyToken(token)
  if (!payload) return res.status(401).json({ error: 'unauthorized', message: 'token 无效或已过期' })

  const user = await q.get(`SELECT ${USER_COLS}, is_banned FROM users WHERE id = ?`, payload.sub)
  if (!user) return res.status(401).json({ error: 'unauthorized', message: '用户不存在' })
  if (Number(user.is_banned)) {
    return res.status(403).json({ error: 'account_suspended', message: '账号已被停用，请联系运营支持' })
  }
  const device = payload.sid
    ? await q.get('SELECT id FROM user_devices WHERE session_id = ? AND user_id = ?', payload.sid, user.id)
    : null
  if (!device) return res.status(401).json({ error: 'unauthorized', message: '登录会话已失效，请重新登录' })

  req.user = user
  req.sessionId = payload.sid
  req.deviceId = device.id
  const now = Date.now()
  await q.run('UPDATE user_devices SET last_active = ? WHERE id = ? AND last_active < ?', now, device.id, now - 60_000)
  next()
}

/* ---------- 用户出参（不含密码） ---------- */
/** 公开字段清单 —— 只在这一处维护，避免各路由 SELECT 漏字段导致资料悄悄丢 */
export const USER_COLS =
  'id, username, nickname, avatar, profile_cover, bio, gender, birthday, region, tags, phone, email, ' +
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
    /* 个人主页封面：和头像同级，属于「别人也会看到的装饰」，所以走 publicUser。 */
    profileCover: row.profile_cover || null,
    bio: row.bio,
    gender: row.gender || null,
    birthday: row.birthday || null,
    region: row.region || null,
    tags: parseTags(row.tags),
    /* ⚠️ 这里**故意没有** phone。`publicUser` 是「别人看到的你」，
       手机号一旦写进来，`/users/:id`、发现页、群成员列表就全都在泄露它。
       自己的手机号走 `selfUser()`，只有 /auth/me 与登录这两个出口用它。 */
    city: row.city || null,
    cityPublic,
    ...(cityPublic && Number.isFinite(row.city_lat) && Number.isFinite(row.city_lng)
      ? { cityLat: row.city_lat, cityLng: row.city_lng }
      : {}),
  }
}

/**
 * 「我自己看到的我」= publicUser + 只对我可见的字段（手机号）。
 *
 * 为什么要单独一个函数而不是给 publicUser 加个 `isSelf` 开关：
 *   加开关的话，任何一个调用点传错参数就是一次数据泄露，而且是**静默**的；
 *   分成两个名字之后，泄露需要有人主动写 `selfUser` —— 在 code review 里一眼能看见。
 * 出口只有两处：登录响应与 `/auth/me`（含 PATCH 回包）。
 */
export function selfUser(row) {
  const u = publicUser(row)
  if (!u) return null
  return { ...u, phone: row.phone || null, email: row.email || null }
}
