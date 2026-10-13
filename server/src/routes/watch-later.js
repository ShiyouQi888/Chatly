import { Router } from 'express'
import { authRequired } from '../auth.js'
import { db } from '../db.js'

const router = Router()

/* ===== 稍后看 =====
 * 用户可以在聊天中长按消息 →「稍后看」，把消息保存到稍后看列表。
 * 稍后看列表独立于收藏，用于标记「稍后需要处理」的消息。
 */

// 获取稍后看列表
router.get('/', authRequired, (req, res, next) => {
  try {
    const userId = req.user.id
    const { limit = 20, beforeId } = req.query

    let sql = `
      SELECT wl.id, wl.message_id, wl.conversation_id, wl.created_at,
             m.kind, m.content, m.file_url, m.file_name,
             c.title as conversation_title, c.type as conversation_type
      FROM watch_later wl
      LEFT JOIN messages m ON wl.message_id = m.id
      LEFT JOIN conversations c ON wl.conversation_id = c.id
      WHERE wl.user_id = ?
    `
    const params = [userId]

    if (beforeId) {
      sql += ' AND wl.id < ?'
      params.push(Number(beforeId))
    }

    sql += ' ORDER BY wl.id DESC LIMIT ?'
    params.push(Number(limit))

    const rows = db.prepare(sql).all(...params)

    // 获取总数
    const { total } = db.prepare(
      'SELECT COUNT(*) as total FROM watch_later WHERE user_id = ?'
    ).get(userId)

    res.json({
      items: rows,
      total,
      hasMore: rows.length === Number(limit),
    })
  } catch (err) {
    next(err)
  }
})

// 添加到稍后看
router.post('/', authRequired, (req, res, next) => {
  try {
    const userId = req.user.id
    const { messageId, conversationId } = req.body

    if (!messageId || !conversationId) {
      return res.status(400).json({ error: '缺少 messageId 或 conversationId' })
    }

    // 检查是否已存在
    const existing = db.prepare(
      'SELECT id FROM watch_later WHERE user_id = ? AND message_id = ?'
    ).get(userId, messageId)

    if (existing) {
      return res.json({ created: false, id: existing.id })
    }

    const result = db.prepare(
      'INSERT INTO watch_later (user_id, message_id, conversation_id) VALUES (?, ?, ?)'
    ).run(userId, messageId, conversationId)

    res.status(201).json({ created: true, id: result.lastInsertRowid })
  } catch (err) {
    next(err)
  }
})

// 从稍后看移除
router.delete('/:id', authRequired, (req, res, next) => {
  try {
    const userId = req.user.id
    const { id } = req.params

    const result = db.prepare(
      'DELETE FROM watch_later WHERE id = ? AND user_id = ?'
    ).run(id, userId)

    if (result.changes === 0) {
      return res.status(404).json({ error: '稍后看记录不存在' })
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// 按消息 ID 移除（用于取消稍后看）
router.delete('/message/:messageId', authRequired, (req, res, next) => {
  try {
    const userId = req.user.id
    const { messageId } = req.params

    const result = db.prepare(
      'DELETE FROM watch_later WHERE message_id = ? AND user_id = ?'
    ).run(messageId, userId)

    res.json({ ok: true, deleted: result.changes > 0 })
  } catch (err) {
    next(err)
  }
})

export default router
