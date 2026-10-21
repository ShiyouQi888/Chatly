/**
 * 运营后台 API。所有路由都要求登录，并再次校验服务端配置的管理员 ID。
 * 私聊消息正文不开放给后台，避免运营权限变成读取私人聊天的入口。
 */
import { Router } from 'express'
import { authRequired, hashPassword, verifyPassword, selfUser, USER_COLS } from '../auth.js'
import { q, tx, info, DB_DRIVER } from '../db.js'
import { status as redisStatus } from '../redis.js'
import { removeUpload } from '../upload.js'
import { revokeDeviceSockets } from '../ws.js'

const r = Router()
r.use(authRequired)

const ROLE_PERMISSIONS = {
  owner: ['overview', 'analytics', 'users.view', 'users.manage', 'content.moments', 'content.comments', 'support', 'audit', 'system', 'staff.manage'],
  moderator: ['overview', 'analytics', 'content.moments', 'content.comments'],
  support: ['overview', 'analytics', 'users.view', 'users.manage', 'support'],
  analyst: ['overview', 'analytics', 'audit', 'system'],
}
const STAFF_ROLES = new Set(['moderator', 'support', 'analyst'])

function configuredAdminAccount() {
  /* One immutable root account comes from the server environment. The legacy plural
     variable is read only as a migration fallback, and only its first value is used. */
  return String(process.env.ADMIN_ACCOUNT || process.env.ADMIN_USER_ID || process.env.ADMIN_USER_IDS || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
}

function isConfiguredAdmin(account, user) {
  if (!account || !user) return false
  return account === String(user.id) || account === String(user.username || '').trim().toLowerCase()
}

r.use(async (req, res, next) => {
  const configuredRoot = await q.get(
    `SELECT root.user_id, admin.username
     FROM admin_root root JOIN users admin ON admin.id = root.user_id
     WHERE root.singleton = 1`
  )
  const adminAccount = configuredAdminAccount()
  const isOwner = configuredRoot
    ? String(configuredRoot.user_id) === String(req.user.id)
    : isConfiguredAdmin(adminAccount, req.user)
  const staff = isOwner ? null : await q.get('SELECT role FROM admin_staff WHERE user_id = ?', req.user.id)
  if (!configuredRoot && !adminAccount) {
    return res.status(503).json({ error: '尚未初始化固定管理员，请在服务端配置 ADMIN_USERNAME 和 ADMIN_PASSWORD 后重启服务' })
  }
  if (!isOwner && !staff) {
    const configuredUsername = configuredRoot?.username || adminAccount
    const hint = configuredUsername
      ? `请退出后使用固定管理员账号 @${configuredUsername} 登录。`
      : '请检查服务端 ADMIN_USERNAME / ADMIN_PASSWORD 配置并重启后端。'
    return res.status(403).json({ error: `当前账号 @${req.user.username}（ID ${req.user.id}）没有运营后台权限。${hint}` })
  }
  req.adminRole = isOwner ? 'owner' : staff.role
  req.adminPermissions = ROLE_PERMISSIONS[req.adminRole] || []
  next()
})

function requirePermission(permission) {
  return (req, res, next) => req.adminPermissions.includes(permission)
    ? next()
    : res.status(403).json({ error: '当前运营角色没有执行此操作的权限' })
}

function requireOwner(req, res, next) {
  return req.adminRole === 'owner' ? next() : res.status(403).json({ error: '仅超级管理员可以管理后台成员' })
}

async function audit(adminId, action, targetType, targetId = null, detail = {}) {
  await q.run(
    `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    adminId,
    action,
    targetType,
    targetId,
    JSON.stringify(detail),
    Date.now()
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
    operator: { role: req.adminRole, permissions: req.adminPermissions, username: req.user.username },
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
  if (id === Number(req.user.id) && banned) return res.status(400).json({ error: '不能停用当前管理员账号' })
  const target = await q.get('SELECT id, username FROM users WHERE id = ?', id)
  if (!target) return res.status(404).json({ error: '用户不存在' })
  const root = await q.get('SELECT user_id FROM admin_root WHERE singleton = 1')
  if (root && String(root.user_id) === String(target.id) || isConfiguredAdmin(configuredAdminAccount(), target)) {
    return res.status(403).json({ error: '不能停用后台管理员账号' })
  }
  if (await q.get('SELECT user_id FROM admin_staff WHERE user_id = ?', id)) return res.status(403).json({ error: '不能停用后台运营成员账号，请先移除其后台角色' })
  const devices = banned ? await q.all('SELECT id FROM user_devices WHERE user_id = ?', id) : []
  const reason = String(req.body?.reason || '').trim().slice(0, 300)
  const now = Date.now()
  await tx(async () => {
    await q.run(
      `UPDATE users SET is_banned = ?, ban_reason = ?, banned_at = ?, banned_by = ? WHERE id = ?`,
      banned ? 1 : 0,
      banned ? reason || '运营限制' : null,
      banned ? now : null,
      banned ? req.user.id : null,
      id
    )
    if (banned) await q.run('DELETE FROM user_devices WHERE user_id = ?', id)
    await audit(req.user.id, banned ? 'user.suspend' : 'user.restore', 'user', id, { reason: banned ? reason || '运营限制' : '' })
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
    await audit(req.user.id, 'comment.remove', 'comment', id, { momentId: Number(comment.momentId), reason })
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
    await audit(req.user.id, 'moment.remove', 'moment', id, { reason: reason || '运营审核' })
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
    await q.run('UPDATE feedbacks SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?', status, req.user.id, handledAt, id)
    await audit(req.user.id, 'feedback.status', 'feedback', id, { status })
  })
  res.json({ ok: true, id, status, handledAt })
})

r.get('/audit', requirePermission('audit'), async (req, res) => {
  const page = pageOf(req.query.page)
  const limit = limitOf(req.query.limit, 50)
  const query = String(req.query.q || '').trim().slice(0, 80)
  const pattern = `%${query}%`
  const where = query ? 'WHERE l.action LIKE ? OR l.target_type LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?' : ''
  const args = query ? [pattern, pattern, pattern, pattern] : []
  const count = await q.get(`SELECT COUNT(*) AS n FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.admin_id ${where}`, ...args)
  const rows = await q.all(
    `SELECT l.id, l.admin_id AS adminId, l.action, l.target_type AS targetType,
            l.target_id AS targetId, l.detail, l.created_at AS createdAt,
            u.username AS adminUsername, u.nickname AS adminNickname
     FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.admin_id
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
  const rows = await q.all(
    `SELECT s.user_id AS userId, s.role, s.created_at AS createdAt,
            u.username, u.nickname, u.avatar,
            creator.username AS createdByUsername
     FROM admin_staff s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN users creator ON creator.id = s.created_by
     ORDER BY s.created_at DESC`
  )
  res.json({ staff: rows.map((row) => ({ ...row, userId: Number(row.userId), createdAt: Number(row.createdAt) })) })
})

r.post('/credentials', requireOwner, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '')
  const username = String(req.body?.username || '').trim()
  const newPassword = String(req.body?.newPassword || '')
  if (!currentPassword || !username || !newPassword) {
    return res.status(400).json({ error: '请填写当前密码、管理员账号和新密码' })
  }
  if (username.length < 2 || username.length > 32 || !/^[\p{L}\p{N}._-]+$/u.test(username)) {
    return res.status(400).json({ error: '账号需为 2 到 32 位字母、数字、点、下划线或短横线' })
  }
  if (newPassword.length < 12 || newPassword.length > 128) {
    return res.status(400).json({ error: '新密码需为 12 到 128 个字符' })
  }
  const current = await q.get('SELECT password_hash FROM users WHERE id = ?', req.user.id)
  if (!current || !verifyPassword(currentPassword, current.password_hash)) {
    return res.status(401).json({ error: '当前密码不正确' })
  }
  const duplicate = await q.get('SELECT id FROM users WHERE lower(username) = lower(?) AND id != ? LIMIT 1', username, req.user.id)
  if (duplicate) return res.status(409).json({ error: '这个账号已被其他用户使用' })
  if (username === req.user.username && verifyPassword(newPassword, current.password_hash)) {
    return res.status(400).json({ error: '新账号和新密码都没有变化' })
  }

  await tx(async () => {
    await q.run('UPDATE users SET username = ?, password_hash = ? WHERE id = ?', username, hashPassword(newPassword), req.user.id)
    await audit(req.user.id, 'admin.credentials.update', 'admin_root', req.user.id, { usernameChanged: username !== req.user.username })
  })
  const otherDevices = await q.all('SELECT id FROM user_devices WHERE user_id = ? AND id != ?', req.user.id, req.deviceId)
  await q.run('DELETE FROM user_devices WHERE user_id = ? AND id != ?', req.user.id, req.deviceId)
  for (const device of otherDevices) revokeDeviceSockets(req.user.id, device.id)
  const updated = await q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, req.user.id)
  res.json({ ok: true, user: selfUser(updated), revokedDevices: otherDevices.length })
})

r.post('/staff', requireOwner, async (req, res) => {
  const userId = Number(req.body?.userId)
  const role = String(req.body?.role || '')
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: '用户 ID 无效' })
  if (!STAFF_ROLES.has(role)) return res.status(400).json({ error: '运营角色无效' })
  const target = await q.get('SELECT id, username FROM users WHERE id = ?', userId)
  if (!target) return res.status(404).json({ error: '用户不存在' })
  if (isConfiguredAdmin(configuredAdminAccount(), target)) {
    return res.status(400).json({ error: '该账号已通过超级管理员名单获得权限，无需重复分配角色' })
  }
  const now = Date.now()
  await tx(async () => {
    await q.run(
      `INSERT INTO admin_staff (user_id, role, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, created_by = excluded.created_by, created_at = excluded.created_at`,
      userId, role, req.user.id, now
    )
    await audit(req.user.id, 'staff.role.assign', 'admin_staff', userId, { role })
  })
  res.json({ ok: true, userId, role })
})

r.delete('/staff/:userId', requireOwner, async (req, res) => {
  const userId = Number(req.params.userId)
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: '用户 ID 无效' })
  const target = await q.get('SELECT user_id AS userId, role FROM admin_staff WHERE user_id = ?', userId)
  if (!target) return res.status(404).json({ error: '后台成员不存在' })
  await tx(async () => {
    await q.run('DELETE FROM admin_staff WHERE user_id = ?', userId)
    await audit(req.user.id, 'staff.role.remove', 'admin_staff', userId, { role: target.role })
  })
  res.json({ ok: true, userId })
})

export default r
