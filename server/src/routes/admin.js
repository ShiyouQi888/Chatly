/**
 * 运营后台 API。独立管理员账号与会话认证，普通用户登录态不能访问。
 * 私聊查阅使用独立权限并记录查阅原因与访问范围。
 */
import { Router } from 'express'
import { hashPassword, verifyPassword } from '../auth.js'
import { adminRequired, createAdminSession, publicAdmin } from '../admin-auth.js'
import { authRateLimit } from '../auth-limit.js'
import { q, insert, tx, info, DB_DRIVER } from '../db.js'
import { status as redisStatus } from '../redis.js'
import { removeUpload } from '../upload.js'
import { revokeDeviceSockets } from '../ws.js'
import { privateMessageRoutes } from './admin-private-messages.js'

const r = Router()

const ROLE_PERMISSIONS = {
  owner: ['overview', 'analytics', 'users.view', 'users.manage', 'content.moments', 'content.comments', 'messages.private.read', 'support', 'audit', 'system', 'staff.manage'],
  moderator: ['overview', 'analytics', 'content.moments', 'content.comments'],
  support: ['overview', 'analytics', 'users.view', 'users.manage', 'support'],
  analyst: ['overview', 'analytics', 'audit', 'system'],
}
const STAFF_ROLES = new Set(['moderator', 'support', 'analyst'])

const loginLimit = authRateLimit({
  limit: 12, windowMs: 15 * 60 * 1000, countFailuresOnly: true,
  key: (req) => `admin-login:${req.ip}:${String(req.body?.username || '').trim().toLowerCase()}`,
})

r.post('/login', loginLimit, async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  if (!username || !password || username.length > 128 || password.length > 128) return res.status(400).json({ error: '请填写有效的后台账号和密码' })
  if (!await q.get("SELECT id FROM admin_accounts WHERE role = 'owner'")) {
    return res.status(503).json({ error: '后台管理员尚未配置，请设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 并重建后端容器' })
  }
  const account = await q.get('SELECT * FROM admin_accounts WHERE lower(username) = lower(?)', username)
  if (!account || !verifyPassword(password, account.password_hash)) return res.status(401).json({ error: '后台账号或密码错误' })
  if (!Number(account.is_active)) return res.status(403).json({ error: '该后台账号已停用' })
  const token = await createAdminSession(account.id)
  await audit(publicAdmin(account), 'admin.login', 'admin_account', account.id)
  res.json({ token, admin: publicAdmin(account) })
})

r.use(adminRequired)
r.use((req, _res, next) => {
  req.adminRole = req.admin.role
  req.adminPermissions = ROLE_PERMISSIONS[req.adminRole] || []
  next()
})

r.post('/logout', async (req, res) => {
  await q.run('DELETE FROM admin_sessions WHERE token_hash = ?', req.adminSessionHash)
  res.json({ ok: true })
})

function requirePermission(permission) {
  return (req, res, next) => req.adminPermissions.includes(permission)
    ? next()
    : res.status(403).json({ error: '当前运营角色没有执行此操作的权限' })
}

function requireOwner(req, res, next) {
  return req.adminRole === 'owner' ? next() : res.status(403).json({ error: '仅超级管理员可以管理后台成员' })
}

async function audit(admin, action, targetType, targetId = null, detail = {}) {
  await q.run(
    `INSERT INTO admin_operation_logs (admin_id, admin_username, admin_nickname, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    admin.id, admin.username, admin.nickname, action, targetType, targetId, JSON.stringify(detail), Date.now()
  )
}

function pageOf(value) {
  return Math.max(1, Math.min(100000, Number.parseInt(value, 10) || 1))
}

function limitOf(value, fallback = 20) {
  return Math.max(1, Math.min(100, Number.parseInt(value, 10) || fallback))
}

function groupedRows(rows) {
  return Object.fromEntries(rows.map((row) => [row.day, Number(row.total) || 0]))
}

r.use('/private-conversations', requirePermission('messages.private.read'), privateMessageRoutes(audit))

r.get('/overview', requirePermission('overview'), async (req, res) => {
  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60 * 1000
  const [users, activeUsers, bannedUsers, conversations, messages, moments, feedback, recentFeedback, dbHealth] = await Promise.all([
    q.get('SELECT COUNT(*) AS n FROM users'),
    q.get('SELECT COUNT(DISTINCT sender_id) AS n FROM messages WHERE created_at >= ?', dayAgo),
    q.get('SELECT COUNT(*) AS n FROM users WHERE is_banned = 1'),
    q.get('SELECT COUNT(*) AS n FROM conversations'),
    q.get('SELECT COUNT(*) AS n FROM messages'),
    q.get('SELECT COUNT(*) AS n FROM moments'),
    q.get("SELECT COUNT(*) AS n FROM feedbacks WHERE status IN ('open','in_progress')"),
    q.get('SELECT COUNT(*) AS n FROM feedbacks WHERE created_at >= ?', dayAgo),
    Promise.resolve(info()),
  ])
  res.json({
    stats: {
      users: Number(users?.n) || 0,
      activeUsers24h: Number(activeUsers?.n) || 0,
      bannedUsers: Number(bannedUsers?.n) || 0,
      conversations: Number(conversations?.n) || 0,
      messages: Number(messages?.n) || 0,
      moments: Number(moments?.n) || 0,
      openFeedback: Number(feedback?.n) || 0,
      feedback24h: Number(recentFeedback?.n) || 0,
    },
    service: { uptimeSeconds: Math.round(process.uptime()), database: dbHealth, redis: redisStatus() },
    operator: { ...req.admin, permissions: req.adminPermissions },
    generatedAt: now,
  })
})

r.get('/analytics', requirePermission('analytics'), async (req, res) => {
  const days = Number(req.query.days) === 30 ? 30 : 7
  const now = Date.now()
  const start = new Date(now - (days - 1) * 86400000)
  start.setUTCHours(0, 0, 0, 0)
  const startMs = start.getTime()
  const startSeconds = Math.floor(startMs / 1000)
  const sqlite = DB_DRIVER === 'sqlite'
  const userDay = sqlite ? "strftime('%Y-%m-%d', created_at, 'unixepoch')" : "to_char(to_timestamp(created_at), 'YYYY-MM-DD')"
  const eventDay = sqlite ? "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')" : "to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD')"
  const [newUsers, messages, moments, activeUsers] = await Promise.all([
    q.all(`SELECT ${userDay} AS day, COUNT(*) AS total FROM users WHERE created_at >= ? GROUP BY day`, startSeconds),
    q.all(`SELECT ${eventDay} AS day, COUNT(*) AS total FROM messages WHERE created_at >= ? GROUP BY day`, startMs),
    q.all(`SELECT ${eventDay} AS day, COUNT(*) AS total FROM moments WHERE created_at >= ? GROUP BY day`, startMs),
    q.all(`SELECT ${eventDay} AS day, COUNT(DISTINCT sender_id) AS total FROM messages WHERE created_at >= ? GROUP BY day`, startMs),
  ])
  const series = {
    users: groupedRows(newUsers),
    messages: groupedRows(messages),
    moments: groupedRows(moments),
    activeUsers: groupedRows(activeUsers),
  }
  const from = new Date(startMs)
  const points = Array.from({ length: days }, (_, index) => {
    const date = new Date(from.getTime() + index * 86400000).toISOString().slice(0, 10)
    return { date, users: series.users[date] || 0, messages: series.messages[date] || 0, moments: series.moments[date] || 0, activeUsers: series.activeUsers[date] || 0 }
  })
  res.json({ days, points, generatedAt: now })
})

r.get('/users', requirePermission('users.view'), async (req, res) => {
  const page = pageOf(req.query.page)
  const limit = limitOf(req.query.limit)
  const query = String(req.query.q || '').trim().slice(0, 80)
  const status = ['active', 'banned'].includes(String(req.query.status)) ? String(req.query.status) : ''
  const pattern = `%${query}%`
  const filters = []
  const args = []
  if (query) { filters.push('(username LIKE ? OR nickname LIKE ? OR CAST(id AS TEXT) = ?)'); args.push(pattern, pattern, query) }
  if (status) { filters.push('is_banned = ?'); args.push(status === 'banned' ? 1 : 0) }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const count = await q.get(`SELECT COUNT(*) AS n FROM users ${where}`, ...args)
  const rows = await q.all(
    `SELECT id, username, nickname, avatar, created_at AS createdAt, is_banned AS isBanned,
            ban_reason AS banReason, banned_at AS bannedAt,
            (SELECT COUNT(*) FROM messages m WHERE m.sender_id = users.id) AS messageCount,
            (SELECT COUNT(*) FROM moments x WHERE x.user_id = users.id) AS momentCount
     FROM users ${where}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...args,
    limit,
    (page - 1) * limit
  )
  res.json({
    users: rows.map((row) => ({
      ...row,
      id: Number(row.id),
      isBanned: !!Number(row.isBanned),
      createdAt: Number(row.createdAt) * 1000,
      bannedAt: row.bannedAt == null ? null : Number(row.bannedAt),
      messageCount: Number(row.messageCount) || 0,
      momentCount: Number(row.momentCount) || 0,
    })),
    page,
    limit,
    total: Number(count?.n) || 0,
  })
})

r.get('/users/:id', requirePermission('users.view'), async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '用户 ID 无效' })
  const user = await q.get(
    `SELECT id, username, nickname, avatar, bio, profile_cover AS profileCover,
            gender, birthday, region, tags, created_at AS createdAt,
            is_banned AS isBanned, ban_reason AS banReason, banned_at AS bannedAt,
            (SELECT COUNT(*) FROM messages m WHERE m.sender_id = users.id) AS messageCount,
            (SELECT COUNT(*) FROM moments x WHERE x.user_id = users.id) AS momentCount
     FROM users WHERE id = ?`,
    id
  )
  if (!user) return res.status(404).json({ error: '用户不存在' })
  let tags = []
  try {
    const parsed = Array.isArray(user.tags) ? user.tags : JSON.parse(user.tags || '[]')
    if (Array.isArray(parsed)) tags = parsed.filter((tag) => typeof tag === 'string')
  } catch {}
  res.json({
    user: {
      ...user,
      id: Number(user.id),
      tags,
      createdAt: Number(user.createdAt) * 1000,
      isBanned: !!Number(user.isBanned),
      bannedAt: user.bannedAt == null ? null : Number(user.bannedAt),
      messageCount: Number(user.messageCount) || 0,
      momentCount: Number(user.momentCount) || 0,
    },
  })
})

r.patch('/users/:id/status', requirePermission('users.manage'), async (req, res) => {
  const id = Number(req.params.id)
  const banned = req.body?.banned
  if (!Number.isSafeInteger(id) || id <= 0 || typeof banned !== 'boolean') {
    return res.status(400).json({ error: '用户或状态参数无效' })
  }
  const target = await q.get('SELECT id, username FROM users WHERE id = ?', id)
  if (!target) return res.status(404).json({ error: '用户不存在' })
  const devices = banned ? await q.all('SELECT id FROM user_devices WHERE user_id = ?', id) : []
  const reason = String(req.body?.reason || '').trim().slice(0, 300)
  const now = Date.now()
  await tx(async () => {
    await q.run(
      `UPDATE users SET is_banned = ?, ban_reason = ?, banned_at = ?, banned_by = NULL, banned_by_admin = ? WHERE id = ?`,
      banned ? 1 : 0,
      banned ? reason || '运营限制' : null,
      banned ? now : null,
      banned ? req.admin.id : null,
      id
    )
    if (banned) await q.run('DELETE FROM user_devices WHERE user_id = ?', id)
    await audit(req.admin, banned ? 'user.suspend' : 'user.restore', 'user', id, { reason: banned ? reason || '运营限制' : '' })
  })
  for (const device of devices) revokeDeviceSockets(id, device.id)
  res.json({ ok: true, id, banned })
})

r.get('/moments', requirePermission('content.moments'), async (req, res) => {
  const page = pageOf(req.query.page)
  const limit = limitOf(req.query.limit)
  const query = String(req.query.q || '').trim().slice(0, 100)
  const pattern = `%${query}%`
  const where = query ? "WHERE m.visibility = 'public' AND (m.content LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)" : "WHERE m.visibility = 'public'"
  const args = query ? [pattern, pattern, pattern] : []
  const count = await q.get(`SELECT COUNT(*) AS n FROM moments m JOIN users u ON u.id = m.user_id ${where}`, ...args)
  const rows = await q.all(
    `SELECT m.id, m.user_id AS userId, m.kind, m.content, m.topic, m.visibility,
            m.created_at AS createdAt, u.username, u.nickname,
            (SELECT COUNT(*) FROM moment_media mm WHERE mm.moment_id = m.id) AS mediaCount,
            (SELECT COUNT(*) FROM moment_comments mc WHERE mc.moment_id = m.id) AS commentCount
     FROM moments m JOIN users u ON u.id = m.user_id ${where}
     ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    ...args,
    limit,
    (page - 1) * limit
  )
  res.json({
    moments: rows.map((row) => ({ ...row, id: Number(row.id), userId: Number(row.userId), createdAt: Number(row.createdAt), mediaCount: Number(row.mediaCount) || 0, commentCount: Number(row.commentCount) || 0 })),
    page,
    limit,
    total: Number(count?.n) || 0,
  })
})

r.get('/comments', requirePermission('content.comments'), async (req, res) => {
  const page = pageOf(req.query.page)
  const limit = limitOf(req.query.limit)
  const query = String(req.query.q || '').trim().slice(0, 100)
  const pattern = `%${query}%`
  const where = query ? "WHERE m.visibility = 'public' AND (c.content LIKE ? OR u.username LIKE ? OR u.nickname LIKE ? OR CAST(m.id AS TEXT) = ?)" : "WHERE m.visibility = 'public'"
  const args = query ? [pattern, pattern, pattern, query] : []
  const count = await q.get(`SELECT COUNT(*) AS n FROM moment_comments c JOIN users u ON u.id = c.user_id JOIN moments m ON m.id = c.moment_id ${where}`, ...args)
  const rows = await q.all(
    `SELECT c.id, c.moment_id AS momentId, c.parent_id AS parentId, c.content,
            c.created_at AS createdAt, u.id AS userId, u.username, u.nickname,
            m.content AS momentContent, owner.nickname AS authorNickname
     FROM moment_comments c
     JOIN users u ON u.id = c.user_id
     JOIN moments m ON m.id = c.moment_id
     JOIN users owner ON owner.id = m.user_id
     ${where}
     ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    ...args,
    limit,
    (page - 1) * limit
  )
  res.json({ comments: rows.map((row) => ({ ...row, id: Number(row.id), momentId: Number(row.momentId), parentId: row.parentId == null ? null : Number(row.parentId), userId: Number(row.userId), createdAt: Number(row.createdAt) })), page, limit, total: Number(count?.n) || 0 })
})

r.delete('/comments/:id', requirePermission('content.comments'), async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '评论 ID 无效' })
  const comment = await q.get('SELECT id, moment_id AS momentId FROM moment_comments WHERE id = ?', id)
  if (!comment) return res.status(404).json({ error: '评论不存在' })
  const reason = String(req.body?.reason || '').trim().slice(0, 300) || '运营审核'
  await tx(async () => {
    await q.run('DELETE FROM moment_comments WHERE id = ?', id)
    await audit(req.admin, 'comment.remove', 'comment', id, { momentId: Number(comment.momentId), reason })
  })
  res.json({ ok: true, id })
})

r.delete('/moments/:id', requirePermission('content.moments'), async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '动态 id 无效' })
  const moment = await q.get('SELECT id FROM moments WHERE id = ?', id)
  if (!moment) return res.status(404).json({ error: '动态不存在' })
  const media = await q.all('SELECT url FROM moment_media WHERE moment_id = ?', id)
  const reason = String(req.body?.reason || '').trim().slice(0, 300)
  await tx(async () => {
    await q.run('DELETE FROM moments WHERE id = ?', id)
    await audit(req.admin, 'moment.remove', 'moment', id, { reason: reason || '运营审核' })
  })
  for (const item of media) removeUpload(item.url)
  res.json({ ok: true, id })
})

r.get('/feedback', requirePermission('support'), async (req, res) => {
  const page = pageOf(req.query.page)
  const limit = limitOf(req.query.limit)
  const status = ['open', 'in_progress', 'resolved', 'closed'].includes(String(req.query.status)) ? String(req.query.status) : ''
  const where = status ? 'WHERE f.status = ?' : ''
  const args = status ? [status] : []
  const count = await q.get(`SELECT COUNT(*) AS n FROM feedbacks f ${where}`, ...args)
  const rows = await q.all(
    `SELECT f.id, f.user_id AS userId, f.type, f.description, f.contact, f.screenshot_url AS screenshotUrl,
            f.status, f.created_at AS createdAt, f.handled_at AS handledAt,
            u.username, u.nickname
     FROM feedbacks f JOIN users u ON u.id = f.user_id ${where}
     ORDER BY f.id DESC LIMIT ? OFFSET ?`,
    ...args,
    limit,
    (page - 1) * limit
  )
  res.json({ feedback: rows.map((row) => ({ ...row, id: Number(row.id), userId: Number(row.userId), createdAt: Number(row.createdAt), handledAt: row.handledAt == null ? null : Number(row.handledAt) })), page, limit, total: Number(count?.n) || 0 })
})

r.patch('/feedback/:id', requirePermission('support'), async (req, res) => {
  const id = Number(req.params.id)
  const status = String(req.body?.status || '')
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '反馈 id 无效' })
  if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) return res.status(400).json({ error: '反馈状态无效' })
  const target = await q.get('SELECT id FROM feedbacks WHERE id = ?', id)
  if (!target) return res.status(404).json({ error: '反馈不存在' })
  const handledAt = ['resolved', 'closed'].includes(status) ? Date.now() : null
  await tx(async () => {
    await q.run('UPDATE feedbacks SET status = ?, handled_by = NULL, handled_by_admin = ?, handled_at = ? WHERE id = ?', status, req.admin.id, handledAt, id)
    await audit(req.admin, 'feedback.status', 'feedback', id, { status })
  })
  res.json({ ok: true, id, status, handledAt })
})

r.get('/audit', requirePermission('audit'), async (req, res) => {
  const page = pageOf(req.query.page)
  const limit = limitOf(req.query.limit, 50)
  const query = String(req.query.q || '').trim().slice(0, 80)
  const pattern = `%${query}%`
  const where = query ? 'WHERE l.action LIKE ? OR l.target_type LIKE ? OR l.admin_username LIKE ? OR l.admin_nickname LIKE ?' : ''
  const args = query ? [pattern, pattern, pattern, pattern] : []
  const count = await q.get(`SELECT COUNT(*) AS n FROM admin_operation_logs l ${where}`, ...args)
  const rows = await q.all(
    `SELECT l.id, l.admin_id AS adminId, l.action, l.target_type AS targetType,
            l.target_id AS targetId, l.detail, l.created_at AS createdAt,
            l.admin_username AS adminUsername, l.admin_nickname AS adminNickname
     FROM admin_operation_logs l
     ${where}
     ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    ...args,
    limit,
    (page - 1) * limit
  )
  res.json({ logs: rows.map((row) => {
    let detail = {}
    try { detail = JSON.parse(row.detail || '{}') } catch {}
    return { ...row, id: Number(row.id), adminId: row.adminId == null ? null : Number(row.adminId), targetId: row.targetId == null ? null : Number(row.targetId), createdAt: Number(row.createdAt), detail }
  }), page, limit, total: Number(count?.n) || 0 })
})

r.get('/staff', requireOwner, async (_req, res) => {
  const rows = await q.all(`SELECT a.id, a.username, a.nickname, a.role, a.created_at AS createdAt,
    creator.username AS createdByUsername FROM admin_accounts a
    LEFT JOIN admin_accounts creator ON creator.id = a.created_by
    WHERE a.role != 'owner' AND a.is_active = 1 ORDER BY a.created_at DESC`)
  res.json({ staff: rows.map((row) => ({ ...row, id: Number(row.id), createdAt: Number(row.createdAt) })) })
})

r.post('/credentials', async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '')
  const username = String(req.body?.username || '').trim()
  const newPassword = String(req.body?.newPassword || '')
  if (!currentPassword || username.length < 2 || username.length > 128 || newPassword.length < 12 || newPassword.length > 128) {
    return res.status(400).json({ error: '后台账号需为 2 到 128 个字符，密码需为 12 到 128 个字符' })
  }
  const current = await q.get('SELECT password_hash FROM admin_accounts WHERE id = ?', req.admin.id)
  if (!current || !verifyPassword(currentPassword, current.password_hash)) return res.status(401).json({ error: '当前密码不正确' })
  if (await q.get('SELECT id FROM admin_accounts WHERE lower(username) = lower(?) AND id != ?', username, req.admin.id)) {
    return res.status(409).json({ error: '这个后台账号已被使用' })
  }
  const passwordHash = hashPassword(newPassword)
  await tx(async () => {
    await q.run('UPDATE admin_accounts SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?', username, passwordHash, Date.now(), req.admin.id)
    await q.run('DELETE FROM admin_sessions WHERE account_id = ? AND token_hash != ?', req.admin.id, req.adminSessionHash)
    await audit(req.admin, 'admin.credentials.update', 'admin_account', req.admin.id, { usernameChanged: username !== req.admin.username })
  })
  res.json({ ok: true, admin: { ...req.admin, username } })
})

r.post('/staff', requireOwner, async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const nickname = String(req.body?.nickname || username).trim().slice(0, 40)
  const role = String(req.body?.role || '')
  if (username.length < 2 || username.length > 128 || password.length < 12 || password.length > 128) return res.status(400).json({ error: '后台账号需为 2 到 128 个字符，初始密码需为 12 到 128 个字符' })
  if (!STAFF_ROLES.has(role)) return res.status(400).json({ error: '运营角色无效' })
  const passwordHash = hashPassword(password)
  const id = await tx(async () => {
    const existing = await q.get('SELECT id, is_active FROM admin_accounts WHERE lower(username) = lower(?)', username)
    if (existing && Number(existing.is_active)) throw Object.assign(new Error('这个后台账号已被使用'), { status: 409 })
    const now = Date.now()
    let accountId
    if (existing) {
      accountId = existing.id
      await q.run('UPDATE admin_accounts SET password_hash = ?, nickname = ?, role = ?, is_active = 1, created_by = ?, updated_at = ? WHERE id = ?', passwordHash, nickname, role, req.admin.id, now, accountId)
      await q.run('DELETE FROM admin_sessions WHERE account_id = ?', accountId)
    } else {
      accountId = await insert('INSERT INTO admin_accounts (username, password_hash, nickname, role, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', username, passwordHash, nickname, role, req.admin.id, now, now)
    }
    await audit(req.admin, 'staff.create', 'admin_account', accountId, { role })
    return accountId
  })
  res.json({ ok: true, id: Number(id), role })
})

r.delete('/staff/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '后台成员 ID 无效' })
  const target = await q.get('SELECT id, role FROM admin_accounts WHERE id = ? AND is_active = 1', id)
  if (!target) return res.status(404).json({ error: '后台成员不存在' })
  if (target.role === 'owner') return res.status(403).json({ error: '不能移除超级管理员' })
  await tx(async () => {
    await q.run('UPDATE admin_accounts SET is_active = 0, updated_at = ? WHERE id = ?', Date.now(), id)
    await q.run('DELETE FROM admin_sessions WHERE account_id = ?', id)
    await audit(req.admin, 'staff.remove', 'admin_account', id, { role: target.role })
  })
  res.json({ ok: true, id })
})

r.patch('/staff/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id)
  const role = String(req.body?.role || '')
  if (!Number.isSafeInteger(id) || id <= 0 || !STAFF_ROLES.has(role)) return res.status(400).json({ error: '成员或运营角色无效' })
  await tx(async () => {
    const target = await q.get("SELECT id FROM admin_accounts WHERE id = ? AND role != 'owner' AND is_active = 1", id)
    if (!target) throw Object.assign(new Error('后台成员不存在'), { status: 404 })
    await q.run('UPDATE admin_accounts SET role = ?, updated_at = ? WHERE id = ?', role, Date.now(), id)
    await audit(req.admin, 'staff.role.update', 'admin_account', id, { role })
  })
  res.json({ ok: true, id, role })
})

export default r
