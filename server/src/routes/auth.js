/**
 * /api/v1/auth —— 注册 / 登录 / 当前用户 / 改资料 / 传头像
 */
import { Router } from 'express'
import { q, insert } from '../db.js'
import { hashPassword, verifyPassword, signToken, publicUser, authRequired, USER_COLS } from '../auth.js'
import { sanitizeProfile, updateProfile, readProfile, peersOf } from '../profile.js'
import { uploadImage, removeUpload, AVATAR_MAX } from '../upload.js'
import { broadcastToUsers } from '../ws.js'

const r = Router()

r.post('/register', (req, res) => {
  const { username, password, nickname } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' })
  if (String(username).length < 2) return res.status(400).json({ error: '用户名至少 2 个字符' })
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' })

  if (q.get('SELECT 1 FROM users WHERE username = ?', username)) {
    return res.status(409).json({ error: '用户名已被占用' })
  }

  const id = insert(
    'INSERT INTO users (username, password_hash, nickname, avatar, bio) VALUES (?, ?, ?, ?, ?)',
    username,
    hashPassword(String(password)),
    nickname || username,
    null,
    ''
  )
  const user = q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id)
  res.status(201).json({ user: publicUser(user), token: signToken(user) })
})

r.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' })

  const row = q.get('SELECT * FROM users WHERE username = ?', username)
  if (!row || !verifyPassword(String(password), row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const user = q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, row.id)
  res.json({ user: publicUser(user), token: signToken(user) })
})

r.get('/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) })
})

/* ---------- 修改资料 ---------- */
r.patch('/me', authRequired, (req, res) => {
  const { fields, errors } = sanitizeProfile(req.body || {})
  if (errors.length) return res.status(400).json({ error: errors[0], errors })

  const before = readProfile(req.user.id)
  const user = updateProfile(req.user.id, fields || {})

  // 换掉本地上传的头像时，删掉上一张，否则磁盘只涨不跌（preset: 开头不是文件，跳过）
  if (fields?.avatar !== undefined && before?.avatar && before.avatar !== fields.avatar) {
    removeUpload(before.avatar)
  }

  // 昵称 / 头像变了，同会话的人要立刻看到
  broadcastToUsers(peersOf(req.user.id), 'user.updated', { user })

  res.json({ user })
})

/* ---------- 上传头像 ----------
   直接把文件落盘并写进 users.avatar，一步到位 ——
   分成「上传拿 url」+「再 patch」两步的话，中间失败会留下没人引用的孤儿文件。 */
r.post('/me/avatar', authRequired, uploadImage.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到图片' })

  const before = readProfile(req.user.id)
  const url = `/uploads/${req.file.filename}`
  const user = updateProfile(req.user.id, { avatar: url })

  if (before?.avatar && before.avatar !== url) removeUpload(before.avatar)

  broadcastToUsers(peersOf(req.user.id), 'user.updated', { user })

  res.status(201).json({ user, url, size: req.file.size, maxSize: AVATAR_MAX })
})

export default r

