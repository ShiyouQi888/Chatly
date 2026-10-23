import { Router } from 'express'
import { q, tx } from '../db.js'
import { decryptMessageText } from '../message-crypto.js'

function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'number' && typeof value !== 'string') throw Object.assign(new Error('分页或会话参数无效'), { status: 400 })
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw Object.assign(new Error('分页或会话参数无效'), { status: 400 })
  }
  return number
}

// Mounted behind the separate admin session and messages.private.read permission.
export function privateMessageRoutes(audit) {
  const r = Router()
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })

  r.get('/', async (req, res) => {
    const page = integer(req.query.page, 1, 100000)
    const limit = integer(req.query.limit, 20, 100)
    const userId = integer(req.query.userId, null)
    const query = String(req.query.q || '').trim().slice(0, 80)
    const clauses = ["c.type = 'private'"]
    const args = []
    if (userId) {
      clauses.push('EXISTS (SELECT 1 FROM conversation_members filter_member WHERE filter_member.conversation_id = c.id AND filter_member.user_id = ?)')
      args.push(userId)
    }
    if (query) {
      const id = /^\d+$/.test(query) && Number.isSafeInteger(Number(query)) ? Number(query) : -1
      clauses.push(`(c.id = ? OR EXISTS (SELECT 1 FROM conversation_members filter_member
        JOIN users filter_user ON filter_user.id = filter_member.user_id
        WHERE filter_member.conversation_id = c.id
          AND (filter_user.username LIKE ? OR filter_user.nickname LIKE ? OR filter_user.id = ?)))`)
      args.push(id, `%${query}%`, `%${query}%`, id)
    }
    const where = `WHERE ${clauses.join(' AND ')}`
    const now = Date.now()
    const count = await q.get(`SELECT COUNT(*) AS n FROM conversations c ${where}`, ...args)
    const rows = await q.all(`SELECT c.id, c.created_at AS createdAt,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND (m.burn_at IS NULL OR m.burn_at > ?)) AS messageCount,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND (m.burn_at IS NULL OR m.burn_at > ?)) AS lastMessageAt
      FROM conversations c ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    now, now, ...args, limit, (page - 1) * limit)
    const ids = rows.map((row) => Number(row.id))
    const members = ids.length ? await q.all(`SELECT cm.conversation_id AS conversationId, u.id, u.username, u.nickname
      FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY u.id`, ...ids) : []
    await audit(req.admin, 'private.conversations.list', 'conversation', null, { query, userId, page, limit, conversationIds: ids })
    res.json({ conversations: rows.map((row) => ({
      id: Number(row.id), createdAt: Number(row.createdAt) * 1000,
      messageCount: Number(row.messageCount), lastMessageAt: row.lastMessageAt == null ? null : Number(row.lastMessageAt),
      participants: members.filter((member) => Number(member.conversationId) === Number(row.id)).map((member) => ({ id: Number(member.id), username: member.username, nickname: member.nickname })),
    })), page, limit, total: Number(count?.n) || 0 })
  })

  r.post('/:id/messages/read', async (req, res) => {
    const id = integer(req.params.id, null)
    const beforeId = integer(req.body?.beforeId, null)
    const limit = integer(req.body?.limit, 50, 100)
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    if ([...reason].length < 2 || [...reason].length > 300) return res.status(400).json({ error: '请填写 2 到 300 个字符的查阅原因' })
    const result = await tx(async () => {
      const conversation = await q.get("SELECT id FROM conversations WHERE id = ? AND type = 'private'", id)
      if (!conversation) throw Object.assign(new Error('私聊会话不存在'), { status: 404 })
      const readAt = Date.now()
      const rows = await q.all(`SELECT m.id, m.kind, m.content, m.content_encrypted AS contentEncrypted,
        m.file_name AS fileName, m.file_size AS fileSize, m.created_at AS createdAt, m.revoked_at AS revokedAt,
        u.id AS senderId, u.username, u.nickname FROM messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? AND (m.burn_at IS NULL OR m.burn_at > ?)
        ${beforeId ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`, id, readAt, ...(beforeId ? [beforeId] : []), limit + 1)
      const page = rows.slice(0, limit)
      const messages = page.map((row) => {
        let text = null
        let status = row.revokedAt ? 'revoked' : 'available'
        if (!row.revokedAt && (row.kind === 'text' || row.kind === 'poll')) {
          try { text = row.contentEncrypted ? decryptMessageText(row.content) : row.content || '' }
          catch { status = 'encrypted_unavailable' }
        }
        return {
          id: Number(row.id), conversationId: id, kind: row.kind, text, status,
          encrypted: !!Number(row.contentEncrypted), createdAt: Number(row.createdAt),
          revokedAt: row.revokedAt == null ? null : Number(row.revokedAt),
          sender: { id: row.senderId == null ? null : Number(row.senderId), username: row.username, nickname: row.nickname },
          file: !row.revokedAt && row.fileName ? { name: row.fileName, size: row.fileSize == null ? null : Number(row.fileSize) } : null,
        }
      }).reverse()
      // Commit the access record before disclosing any body. Store identifiers and
      // reason only; never copy plaintext, ciphertext or keys into the audit trail.
      await audit(req.admin, 'private.messages.read', 'conversation', id, {
        reason, beforeId, limit, readAt, messageIds: messages.map((message) => message.id), returnedCount: messages.length,
        unavailableEncryptedCount: messages.filter((message) => message.status === 'encrypted_unavailable').length,
      })
      return { messages, hasMore: rows.length > limit, nextBeforeId: page.length ? Number(page[page.length - 1].id) : null, access: { reason, readAt } }
    })
    res.json(result)
  })
  return r
}
