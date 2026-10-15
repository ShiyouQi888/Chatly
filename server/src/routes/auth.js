/**
 * /api/v1/auth —— 注册 / 登录 / 当前用户 / 改资料 / 传头像
 */
import { Router } from 'express'
import crypto from 'node:crypto'
import { q, insert, tx } from '../db.js'
import { hashPassword, verifyPassword, signToken, publicUser, selfUser, authRequired, USER_COLS } from '../auth.js'
import { sanitizeProfile, updateProfile, readProfile, peersOf } from '../profile.js'
import { uploadImage, uploadCover, removeUpload, AVATAR_MAX, COVER_MAX } from '../upload.js'
import { broadcastToUsers, revokeDeviceSockets } from '../ws.js'
import { authRateLimit } from '../auth-limit.js'

const r = Router()
const loginLimit = authRateLimit({
  limit: 8,
  windowMs: 15 * 60 * 1000,
  key: (req) => `login:${req.ip}:${String(req.body?.identifier || req.body?.username || '').trim().toLowerCase()}`,
  countFailuresOnly: true,
})
const registerLimit = authRateLimit({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  key: (req) => `register:${req.ip}`,
})
const verificationCodeLimit = authRateLimit({
  limit: 4,
  windowMs: 15 * 60 * 1000,
  key: (req) => `register-code:${req.ip}:${req.path}:${String(req.body?.phone || req.body?.email || '').trim().toLowerCase()}`,
})

function normalizePhone(value) {
  const compact = String(value || '').trim().replace(/[\s()-]/g, '')
  if (/^1[3-9]\d{9}$/.test(compact)) return `+86${compact}`
  if (/^\+?[1-9]\d{7,14}$/.test(compact)) return compact.startsWith('+') ? compact : `+${compact}`
  return null
}

function legacyPhone(address) {
  return address.startsWith('+86') && /^\+861[3-9]\d{9}$/.test(address) ? address.slice(3) : address
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

function verificationHash(kind, address, code) {
  const secret = process.env.AUTH_OTP_SECRET || process.env.JWT_SECRET || 'chatly-local-otp-secret-change-me'
  return crypto.createHmac('sha256', secret).update(`${kind}:${address}:${code}`).digest('hex')
}

async function deliverRegistrationCode(kind, address, code) {
  if (kind === 'email') {
    const apiKey = process.env.RESEND_API_KEY
    const from = process.env.AUTH_EMAIL_FROM
    if (!apiKey || !from) throw Object.assign(new Error('邮箱注册尚未配置邮件通道，请配置 RESEND_API_KEY 和 AUTH_EMAIL_FROM'), { status: 503 })
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [address],
        subject: 'Chatly 注册验证码',
        text: `你的 Chatly 注册验证码是 ${code}，10 分钟内有效。若不是你本人操作，请忽略此邮件。`,
      }),
    })
    if (!response.ok) throw Object.assign(new Error('验证码邮件发送失败，请检查邮件服务配置后重试'), { status: 502 })
    return
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM_NUMBER
  if (!accountSid || !authToken || !from) throw Object.assign(new Error('手机号注册尚未配置短信通道，请配置 Twilio 服务端参数'), { status: 503 })
  const body = new URLSearchParams({ To: address, From: from, Body: `你的 Chatly 注册验证码是 ${code}，10 分钟内有效。` })
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  if (!response.ok) throw Object.assign(new Error('短信验证码发送失败，请检查短信服务配置后重试'), { status: 502 })
}

function sendRegistrationCode(kind) {
  return async (req, res) => {
    const address = kind === 'phone' ? normalizePhone(req.body?.phone) : normalizeEmail(req.body?.email)
    if (!address) return res.status(400).json({ error: kind === 'phone' ? '请输入有效的手机号（支持中国大陆手机号或 E.164 格式）' : '请输入有效的邮箱地址' })
    const existing = kind === 'phone'
      ? await q.get('SELECT id FROM users WHERE phone = ? OR phone = ?', address, legacyPhone(address))
      : await q.get('SELECT id FROM users WHERE lower(email) = ?', address)
    if (existing) return res.status(409).json({ error: kind === 'phone' ? '该手机号已注册' : '该邮箱已注册' })

    const now = Date.now()
    const previous = await q.get('SELECT created_at AS createdAt FROM auth_verification_codes WHERE kind = ? AND address = ?', kind, address)
    if (previous && now - Number(previous.createdAt) < 60_000) {
      return res.status(429).json({ error: '验证码已发送，请 60 秒后再获取' })
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const codeHash = verificationHash(kind, address, code)
    try {
      await deliverRegistrationCode(kind, address, code)
      await q.run(
        `INSERT INTO auth_verification_codes (kind, address, code_hash, attempts, expires_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(kind, address) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at`,
        kind, address, codeHash, now + 10 * 60_000, now
      )
      res.status(202).json({ ok: true, message: '验证码已发送，请在 10 分钟内完成注册' })
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || '验证码发送失败' })
    }
  }
}

function registerWithIdentity(kind) {
  return async (req, res) => {
    const address = kind === 'phone' ? normalizePhone(req.body?.phone) : normalizeEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()
    const password = String(req.body?.password || '')
    const nickname = String(req.body?.nickname || '').trim().slice(0, 40)
    if (!address) return res.status(400).json({ error: kind === 'phone' ? '手机号格式不正确' : '邮箱格式不正确' })
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '请输入 6 位验证码' })
    if (password.length < 8) return res.status(400).json({ error: '密码至少需要 8 位' })
    if (password.length > 128) return res.status(400).json({ error: '密码不能超过 128 位' })

    const existing = kind === 'phone'
      ? await q.get('SELECT id FROM users WHERE phone = ? OR phone = ?', address, legacyPhone(address))
      : await q.get('SELECT id FROM users WHERE lower(email) = ?', address)
    if (existing) return res.status(409).json({ error: kind === 'phone' ? '该手机号已注册' : '该邮箱已注册' })

    const verification = await q.get('SELECT code_hash AS codeHash, attempts, expires_at AS expiresAt FROM auth_verification_codes WHERE kind = ? AND address = ?', kind, address)
    if (!verification) return res.status(400).json({ error: '请先获取验证码' })
    if (Number(verification.expiresAt) <= Date.now()) {
      await q.run('DELETE FROM auth_verification_codes WHERE kind = ? AND address = ?', kind, address)
      return res.status(400).json({ error: '验证码已过期，请重新获取' })
    }
    if (Number(verification.attempts) >= 5) {
      await q.run('DELETE FROM auth_verification_codes WHERE kind = ? AND address = ?', kind, address)
      return res.status(429).json({ error: '验证码尝试次数过多，请重新获取' })
    }
    const expected = Buffer.from(String(verification.codeHash), 'hex')
    const received = Buffer.from(verificationHash(kind, address, code), 'hex')
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      await q.run('UPDATE auth_verification_codes SET attempts = attempts + 1 WHERE kind = ? AND address = ?', kind, address)
      return res.status(400).json({ error: '验证码不正确' })
    }

    const username = `${kind === 'phone' ? 'p' : 'e'}_${crypto.randomBytes(12).toString('hex')}`
    let userId
    try {
      userId = await tx(async () => {
        const stillRegistered = kind === 'phone'
          ? await q.get('SELECT id FROM users WHERE phone = ? OR phone = ?', address, legacyPhone(address))
          : await q.get('SELECT id FROM users WHERE lower(email) = ?', address)
        if (stillRegistered) throw Object.assign(new Error(kind === 'phone' ? '该手机号已注册' : '该邮箱已注册'), { status: 409 })
        const id = await insert(
          `INSERT INTO users (username, password_hash, nickname, avatar, bio, phone, email)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          username,
          hashPassword(password),
          nickname || '新用户',
          null,
          '',
          kind === 'phone' ? address : null,
          kind === 'email' ? address : null
        )
        await q.run('INSERT INTO auth_identities (kind, address, user_id, verified_at) VALUES (?, ?, ?, ?)', kind, address, id, Date.now())
        await q.run('DELETE FROM auth_verification_codes WHERE kind = ? AND address = ?', kind, address)
        return id
      })
    } catch (error) {
      if (error.status === 409 || error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: kind === 'phone' ? '该手机号已注册' : '该邮箱已注册' })
      }
      throw error
    }
    const user = await q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, userId)
    const sessionId = await recordLoginDevice(user.id, req)
    res.status(201).json({ user: selfUser(user), token: signToken(user, sessionId) })
  }
}

function recordLoginDevice(userId, req) {
  const sessionId = crypto.randomUUID()
  const ua = String(req.get('user-agent') || 'Unknown device').slice(0, 160)
  const type = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop'
  return insert(
    `INSERT INTO user_devices (user_id, device_name, device_type, session_id, last_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId, ua, type, sessionId, Date.now(), Date.now()
  ).then(() => sessionId)
}

r.post('/register', registerLimit, async (req, res) => {
  const { username, password, nickname } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' })
  if (String(username).length < 2) return res.status(400).json({ error: '用户名至少 2 个字符' })
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' })

  if (await q.get('SELECT 1 FROM users WHERE username = ?', username)) {
    return res.status(409).json({ error: '用户名已被占用' })
  }

  const id = await insert(
    'INSERT INTO users (username, password_hash, nickname, avatar, bio) VALUES (?, ?, ?, ?, ?)',
    username,
    hashPassword(String(password)),
    nickname || username,
    null,
    ''
  )
  const user = await q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id)
  const sessionId = await recordLoginDevice(user.id, req)
  res.status(201).json({ user: selfUser(user), token: signToken(user, sessionId) })
})

r.post('/register/phone/code', verificationCodeLimit, sendRegistrationCode('phone'))
r.post('/register/email/code', verificationCodeLimit, sendRegistrationCode('email'))
r.post('/register/phone', registerLimit, registerWithIdentity('phone'))
r.post('/register/email', registerLimit, registerWithIdentity('email'))

r.post('/login', loginLimit, async (req, res) => {
  const { password } = req.body || {}
  const identifier = String(req.body?.identifier || req.body?.username || '').trim()
  if (!identifier || !password) return res.status(400).json({ error: '账号或手机号/邮箱与密码必填' })

  const normalizedPhone = normalizePhone(identifier)
  const normalizedEmail = normalizeEmail(identifier)
  const row = normalizedPhone
    ? await q.get('SELECT * FROM users WHERE phone = ? OR phone = ? LIMIT 1', normalizedPhone, legacyPhone(normalizedPhone))
    : normalizedEmail
      ? await q.get('SELECT * FROM users WHERE lower(email) = ? LIMIT 1', normalizedEmail)
      : await q.get('SELECT * FROM users WHERE username = ? LIMIT 1', identifier)
  if (!row || !verifyPassword(String(password), row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }
  if (Number(row.is_banned)) return res.status(403).json({ error: '账号已停用，请联系运营支持' })

  const user = await q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, row.id)
  const sessionId = await recordLoginDevice(user.id, req)
  res.json({ user: selfUser(user), token: signToken(user, sessionId) })
})

r.get('/me', authRequired, (req, res) => {
  res.json({ user: selfUser(req.user) })
})

r.post('/logout', authRequired, async (req, res) => {
  await q.run('DELETE FROM user_devices WHERE id = ? AND user_id = ?', req.deviceId, req.user.id)
  revokeDeviceSockets(req.user.id, req.deviceId)
  res.json({ ok: true })
})

/* ---------- 修改资料 ---------- */
r.patch('/me', authRequired, async (req, res) => {
  const { fields, errors } = sanitizeProfile(req.body || {})
  if (errors.length) return res.status(400).json({ error: errors[0], errors })

  const before = await readProfile(req.user.id)
  const row = await updateProfile(req.user.id, fields || {})

  // 换掉本地上传的头像时，删掉上一张，否则磁盘只涨不跌（preset: 开头不是文件，跳过）
  if (fields?.avatar !== undefined && before?.avatar && before.avatar !== fields.avatar) {
    removeUpload(before.avatar)
  }

  // 封面同理：换了就删旧的，不然每换一次背景磁盘上就多留一张没人引用的图
  if (
    fields?.profile_cover !== undefined &&
    before?.profile_cover &&
    before.profile_cover !== fields.profile_cover
  ) {
    removeUpload(before.profile_cover)
  }

  /* 昵称 / 头像变了，同会话的人要立刻看到。
     ⚠️ 推出去的是 `publicUser(row)`（**不含手机号**）——
     这里差一点就变成「改一次资料，把手机号推给所有聊过的人」。 */
  broadcastToUsers(await peersOf(req.user.id), 'user.updated', { user: publicUser(row) })

  res.json({ user: selfUser(row) })
})

/* ---------- 上传头像 ----------
   直接把文件落盘并写进 users.avatar，一步到位 ——
   分成「上传拿 url」+「再 patch」两步的话，中间失败会留下没人引用的孤儿文件。 */
r.post('/me/avatar', authRequired, uploadImage.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到图片' })

  const before = await readProfile(req.user.id)
  const url = `/uploads/${req.file.filename}`
  const row = await updateProfile(req.user.id, { avatar: url })

  if (before?.avatar && before.avatar !== url) removeUpload(before.avatar)

  broadcastToUsers(await peersOf(req.user.id), 'user.updated', { user: publicUser(row) })

  res.status(201).json({ user: selfUser(row), url, size: req.file.size, maxSize: AVATAR_MAX })
})

/* ---------- 上传主页背景 ----------
   和头像同一条设计：一步落库，不留「传了但没引用」的孤儿文件。
   传成功后删掉上一张背景 —— 背景可以反复换，不清理的话磁盘只涨不跌。 */
r.post('/me/cover', authRequired, uploadCover.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到图片' })

  const before = await readProfile(req.user.id)
  const url = `/uploads/${req.file.filename}`
  const row = await updateProfile(req.user.id, { profile_cover: url })

  if (before?.profile_cover && before.profile_cover !== url) removeUpload(before.profile_cover)

  /* 封面是公开资料（他人资料页也渲染它），所以要推给同会话的人 ——
     和改头像完全同构，推的一律是 publicUser（不含手机号）。 */
  broadcastToUsers(await peersOf(req.user.id), 'user.updated', { user: publicUser(row) })

  res.status(201).json({ user: selfUser(row), url, size: req.file.size, maxSize: COVER_MAX })
})

/* ---------- 修改密码 ----------
   `password_hash` 是库里真有的字段，登录也确实校验它 —— 「修改密码」不是
   没能力做，只是之前没人补这条接口。
   ⚠️ 必须先验旧密码：不验的话，谁在没锁屏的电脑上发一个请求就能改掉
   别人的密码，把号主锁在门外。 */
r.post('/me/password', authRequired, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '旧密码和新密码都要填' })
  if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' })

  /* authRequired 放进 `req.user` 的是 USER_COLS（**不含** password_hash ——
     出参形状永远不该带哈希），所以这里按 id 重取一次哈希列。 */
  const row = await q.get('SELECT password_hash FROM users WHERE id = ?', req.user.id)
  if (!row || !verifyPassword(String(oldPassword), row.password_hash)) {
    return res.status(401).json({ error: '旧密码不正确' })
  }
  if (verifyPassword(String(newPassword), row.password_hash)) {
    return res.status(400).json({ error: '新密码不能和旧密码相同' })
  }

  await q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(newPassword)), req.user.id)
  const otherDevices = await q.all('SELECT id FROM user_devices WHERE user_id = ? AND id != ?', req.user.id, req.deviceId)
  await q.run('DELETE FROM user_devices WHERE user_id = ? AND id != ?', req.user.id, req.deviceId)
  for (const device of otherDevices) revokeDeviceSockets(req.user.id, device.id)

  /* 诚实说明：JWT 是无状态的，改了密码**不会**踢掉其它设备上已签发的 token
     （那需要服务端会话黑名单，本项目没有）。所以这里不假装「已退出所有设备」，
     界面上也要把这一点写出来。 */
  res.json({ ok: true })
})

export default r

