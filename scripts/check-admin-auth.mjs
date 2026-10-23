/** Isolated regression for admin/user identity separation and account recovery. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatly-admin-auth-'))
process.env.DB_DRIVER = 'sqlite'
process.env.DB_PATH = path.join(temp, 'test.db')
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-user-token-signing-key-for-admin-regression'
process.env.ADMIN_USERNAME = 'operator@example.com'
process.env.ADMIN_PASSWORD = 'Admin-only-password-123'
process.env.ADMIN_NICKNAME = '测试运营'
const express = createRequire(new URL('../server/package.json', import.meta.url))('express')
const { q, insert, close } = await import('../server/src/db.js')
const { hashPassword, verifyPassword } = await import('../server/src/auth.js')
const { bootstrapAdmin } = await import('../server/src/admin-bootstrap.js')
const adminRoutes = (await import('../server/src/routes/admin.js')).default
const authRoutes = (await import('../server/src/routes/auth.js')).default
let server
try {
  const userPassword = 'User-only-password-123'
  const userId = await insert('INSERT INTO users (username, password_hash, nickname, email) VALUES (?, ?, ?, ?)', 'e_ordinary', hashPassword(userPassword), '普通用户', process.env.ADMIN_USERNAME)
  const legacyStaffId = await insert('INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)', 'legacy_staff', hashPassword(userPassword), '原客服')
  await q.run('INSERT INTO admin_root (singleton, user_id) VALUES (1, ?)', userId)
  await q.run("INSERT INTO admin_staff (user_id, role, created_by) VALUES (?, 'support', ?)", legacyStaffId, userId)
  await q.run("INSERT INTO admin_audit_logs (admin_id, action, target_type) VALUES (?, 'legacy.action', 'user')", userId)
  const originalHash = (await q.get('SELECT password_hash FROM users WHERE id = ?', userId)).password_hash
  await bootstrapAdmin()
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM users')).n, 2)
  assert.equal((await q.get('SELECT password_hash FROM users WHERE id = ?', userId)).password_hash, originalHash)
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM admin_operation_logs WHERE legacy_log_id IS NOT NULL')).n, 1)
  console.log('PASS legacy migration preserves ordinary users, passwords and audit history')

  const app = express()
  app.use(express.json())
  app.use('/admin', adminRoutes)
  app.use('/auth', authRoutes)
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }))
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (route, { token, body, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, cacheControl: response.headers.get('cache-control'), data: await response.json() }
  }
  const adminLogin = (username = process.env.ADMIN_USERNAME, password = process.env.ADMIN_PASSWORD) => request('/admin/login', { body: { username, password } })
  const login = await adminLogin()
  assert.equal(login.status, 200, JSON.stringify(login.data))
  const token = login.data.token
  assert.ok(token.startsWith('admin_'))
  assert.equal((await adminLogin(process.env.ADMIN_USERNAME, userPassword)).status, 401)
  const ordinary = await request('/auth/login', { body: { identifier: process.env.ADMIN_USERNAME, password: userPassword } })
  assert.equal(ordinary.status, 200)
  assert.equal((await request('/admin/overview', { token: ordinary.data.token })).status, 401)
  assert.equal((await request('/auth/me', { token })).status, 401)
  assert.equal((await request('/auth/login', { body: { identifier: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD } })).status, 401)
  console.log('PASS same email can identify separate admin/user accounts; tokens cannot cross domains')

  assert.equal((await request(`/admin/users/${userId}/status`, { token, method: 'PATCH', body: { banned: true } })).status, 200)
  assert.equal((await request('/admin/overview', { token })).status, 200)
  assert.equal((await q.get('SELECT banned_by_admin FROM users WHERE id = ?', userId)).banned_by_admin, login.data.admin.id)
  assert.equal((await request(`/admin/users/${userId}/status`, { token, method: 'PATCH', body: { banned: false } })).status, 200)
  const userAgain = await request('/auth/login', { body: { identifier: process.env.ADMIN_USERNAME, password: userPassword } })
  assert.equal((await request('/auth/logout', { token: userAgain.data.token, method: 'POST' })).status, 200)
  assert.equal((await request('/admin/overview', { token })).status, 200)
  const feedbackId = await insert('INSERT INTO feedbacks (user_id, description) VALUES (?, ?)', userId, '测试反馈')
  assert.equal((await request(`/admin/feedback/${feedbackId}`, { token, method: 'PATCH', body: { status: 'resolved' } })).status, 200)
  assert.equal((await q.get('SELECT handled_by_admin FROM feedbacks WHERE id = ?', feedbackId)).handled_by_admin, login.data.admin.id)
  console.log('PASS user suspension is independent of matching admin IDs and uses admin attribution')

  process.env.MESSAGE_ENCRYPTION_KEY = '11'.repeat(32)
  const { encryptMessageText } = await import('../server/src/message-crypto.js')
  const privateId = await insert("INSERT INTO conversations (type) VALUES ('private')")
  const groupId = await insert("INSERT INTO conversations (type, title) VALUES ('group', 'Private read regression group')")
  for (const participant of [userId, legacyStaffId]) await q.run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', privateId, participant)
  const plainText = 'PRIVATE_READ_PLAINTEXT_SAMPLE'
  const encryptedText = 'PRIVATE_READ_ENCRYPTED_SAMPLE'
  const ciphertext = encryptMessageText(encryptedText)
  const message = (kind, content, encrypted = 0, revoked = null, burn = null, fileName = null) => insert(
    'INSERT INTO messages (conversation_id, sender_id, kind, content, content_encrypted, revoked_at, burn_at, file_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    privateId, userId, kind, content, encrypted, revoked, burn, fileName)
  const plainId = await message('text', plainText)
  const encryptedId = await message('text', ciphertext, 1)
  const revokedId = await message('text', 'PRIVATE_REVOKED_DO_NOT_DISCLOSE', 0, Date.now())
  const expiredId = await message('text', 'PRIVATE_EXPIRED_DO_NOT_DISCLOSE', 0, null, Date.now() - 1000)
  const fileId = await message('file', null, 0, null, null, 'attachment.txt')
  const userSession = await request('/auth/login', { body: { identifier: process.env.ADMIN_USERNAME, password: userPassword } })
  assert.equal((await request('/admin/private-conversations', { token: userSession.data.token })).status, 401)
  const listed = await request('/admin/private-conversations?q=e_ordinary', { token })
  assert.equal(listed.status, 200, JSON.stringify(listed.data))
  assert.equal(listed.cacheControl, 'private, no-store')
  assert.equal(listed.data.total, 1)
  assert.equal(listed.data.conversations[0].messageCount, 4)
  assert.equal(listed.data.conversations[0].participants.length, 2)
  assert.ok(!JSON.stringify(listed.data).includes(plainText))
  const readRoute = `/admin/private-conversations/${privateId}/messages/read`
  const notificationsBefore = (await q.get('SELECT COUNT(*) AS n FROM notifications')).n
  assert.equal((await request(readRoute, { token, body: {} })).status, 400)
  assert.equal((await request(readRoute, { token, body: { reason: {} } })).status, 400)
  assert.equal((await request(readRoute, { token, body: { reason: '核查举报', limit: 101 } })).status, 400)
  assert.equal((await request(readRoute, { token, body: { reason: '核查举报', beforeId: 'bad' } })).status, 400)
  assert.equal((await request(`/admin/private-conversations/${groupId}/messages/read`, { token, body: { reason: '核查举报' } })).status, 404)
  const first = await request(readRoute, { token, body: { reason: '核查举报 #123', limit: 2 } })
  assert.equal(first.status, 200, JSON.stringify(first.data))
  assert.equal(first.cacheControl, 'private, no-store')
  assert.deepEqual(first.data.messages.map((item) => item.id), [revokedId, fileId])
  assert.equal(first.data.messages[0].status, 'revoked')
  assert.equal(first.data.messages[0].text, null)
  assert.equal(first.data.hasMore, true)
  assert.equal(first.data.nextBeforeId, revokedId)
  const older = await request(readRoute, { token, body: { reason: '核查举报 #123', beforeId: first.data.nextBeforeId, limit: 2 } })
  assert.equal(older.status, 200)
  assert.deepEqual(older.data.messages.map((item) => item.id), [plainId, encryptedId])
  assert.deepEqual(older.data.messages.map((item) => item.text), [plainText, encryptedText])
  assert.equal(older.data.hasMore, false)
  assert.ok(![...first.data.messages, ...older.data.messages].some((item) => item.id === expiredId))
  assert.equal((await q.get('SELECT last_read_message_id AS n FROM conversation_members WHERE conversation_id = ? AND user_id = ?', privateId, userId)).n, 0)
  assert.equal((await q.get('SELECT burn_at FROM messages WHERE id = ?', plainId)).burn_at, null)
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM notifications')).n, notificationsBefore)
  const accesses = await q.all("SELECT detail FROM admin_operation_logs WHERE action = 'private.messages.read' ORDER BY id")
  assert.equal(accesses.length, 2)
  assert.equal(JSON.parse(accesses[0].detail).reason, '核查举报 #123')
  assert.deepEqual(JSON.parse(accesses[1].detail).messageIds, [plainId, encryptedId])
  for (const sensitive of [plainText, encryptedText, ciphertext, 'PRIVATE_REVOKED_DO_NOT_DISCLOSE', 'PRIVATE_EXPIRED_DO_NOT_DISCLOSE']) assert.ok(!JSON.stringify(accesses).includes(sensitive))
  process.env.MESSAGE_ENCRYPTION_KEY = '22'.repeat(32)
  const wrongKey = await request(readRoute, { token, body: { reason: '核查密钥异常' } })
  assert.equal(wrongKey.status, 200)
  assert.equal(wrongKey.data.messages.find((item) => item.id === encryptedId).status, 'encrypted_unavailable')
  assert.equal(wrongKey.data.messages.find((item) => item.id === encryptedId).text, null)
  assert.ok(!JSON.stringify(wrongKey.data).includes(ciphertext))
  process.env.MESSAGE_ENCRYPTION_KEY = '11'.repeat(32)
  await q.run("CREATE TRIGGER admin_private_audit_fail BEFORE INSERT ON admin_operation_logs WHEN NEW.action = 'private.messages.read' BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END")
  const auditFailure = await request(readRoute, { token, body: { reason: '核查审计失败' } })
  assert.equal(auditFailure.status, 500)
  assert.equal(auditFailure.data.messages, undefined)
  assert.ok(!JSON.stringify(auditFailure.data).includes(plainText))
  await q.run('DROP TRIGGER admin_private_audit_fail')
  console.log('PASS private messages: audited cursor paging, decryption, revoked/expired exclusions, no read side effects, fail closed on audit errors')

  const newStaff = { username: 'reviewer@example.com', password: 'Reviewer-password-123', nickname: '审核员', role: 'moderator' }
  const created = await request('/admin/staff', { token, body: newStaff })
  assert.equal(created.status, 200, JSON.stringify(created.data))
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM users')).n, 2)
  const staffLogin = await adminLogin(newStaff.username, newStaff.password)
  assert.equal(staffLogin.status, 200)
  assert.equal((await request('/admin/moments', { token: staffLogin.data.token })).status, 200)
  assert.equal((await request('/admin/users', { token: staffLogin.data.token })).status, 403)
  assert.equal((await request('/admin/staff', { token: staffLogin.data.token })).status, 403)
  for (const role of ['moderator', 'support', 'analyst']) {
    assert.equal((await request(`/admin/staff/${created.data.id}`, { token, method: 'PATCH', body: { role } })).status, 200)
    assert.equal((await request('/admin/private-conversations', { token: staffLogin.data.token })).status, 403)
    assert.equal((await request(readRoute, { token: staffLogin.data.token, body: { reason: '尝试越权读取' } })).status, 403)
  }
  console.log('PASS all non-owner admin roles are denied private conversation lists and bodies')
  assert.equal((await request(`/admin/staff/${created.data.id}`, { token, method: 'PATCH', body: { role: 'analyst' } })).status, 200)
  assert.equal((await request('/admin/moments', { token: staffLogin.data.token })).status, 403)
  assert.equal((await request('/admin/audit', { token: staffLogin.data.token })).status, 200)
  assert.equal((await request(`/admin/staff/${created.data.id}`, { token, method: 'DELETE' })).status, 200)
  assert.equal((await request('/admin/overview', { token: staffLogin.data.token })).status, 401)
  console.log('PASS standalone staff creation, role permissions and immediate session revocation')

  const other = await adminLogin()
  const updatedUsername = 'updated@example.com'
  const updatedPassword = 'Updated-admin-password-123'
  const changed = await request('/admin/credentials', { token, body: { currentPassword: process.env.ADMIN_PASSWORD, username: updatedUsername, newPassword: updatedPassword } })
  assert.equal(changed.status, 200, JSON.stringify(changed.data))
  assert.equal((await request('/admin/overview', { token })).status, 200)
  assert.equal((await request('/admin/overview', { token: other.data.token })).status, 401)
  await bootstrapAdmin()
  assert.equal((await adminLogin(updatedUsername, updatedPassword)).status, 200)
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM admin_operation_logs WHERE legacy_log_id IS NOT NULL')).n, 1)
  assert.equal((await q.get('SELECT password_hash FROM users WHERE id = ?', userId)).password_hash, originalHash)
  process.env.ADMIN_PASSWORD = 'Recovered-admin-password-456'
  await bootstrapAdmin()
  assert.equal((await request('/admin/overview', { token })).status, 401)
  const recovered = await adminLogin()
  assert.equal(recovered.status, 200)
  assert.equal((await request('/admin/logout', { token: recovered.data.token, method: 'POST' })).status, 200)
  assert.equal((await request('/admin/overview', { token: recovered.data.token })).status, 401)
  console.log('PASS credential edits survive unchanged env, env recovery revokes sessions, logout revokes token')

  // Exercise a fresh independent owner insert after clearing only this temporary DB.
  await q.run('DELETE FROM admin_operation_logs')
  await q.run('UPDATE users SET banned_by_admin = NULL')
  await q.run('UPDATE feedbacks SET handled_by_admin = NULL')
  await q.run('DELETE FROM admin_accounts')
  await bootstrapAdmin()
  assert.equal((await adminLogin()).status, 200)
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM users')).n, 2)
  assert.ok(verifyPassword(userPassword, (await q.get('SELECT password_hash FROM users WHERE id = ?', userId)).password_hash))
  console.log('PASS fresh admin provisioning creates no Chatly user')
} finally {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  await close()
  fs.rmSync(temp, { recursive: true, force: true })
}
