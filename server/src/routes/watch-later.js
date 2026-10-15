/**
 * /api/v1/watch-later —— 「稍后看」
 *
 * 用户在聊天中长按消息 →「稍后看」，把消息保存到一个独立列表。
 * 和收藏的区别：稍后看是**引用**（消息撤回 / 物理删除后条目跟着消失，
 * 靠 message_id 上的 ON DELETE CASCADE），收藏是**快照**（消息没了收藏还在）。
 *
 * ⚠️ 原来是 `db.prepare(...)` 直连 SQLite —— PG 模式下会撞上门面那个报错代理，
 *    现在统一走 `q.*` / `insert()`。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { q, insert } from '../db.js'
import { decryptMessageText } from '../message-crypto.js'

const router = Router()

// 获取稍后看列表
router.get('/', authRequired, async (req, res, next) => {
  try {
    const userId = req.user.id
    const { limit = 20, beforeId } = req.query

    let sql = `
      SELECT wl.id, wl.message_id, wl.conversation_id, wl.created_at,
             m.kind, m.content, m.content_encrypted, m.burn_at, m.file_url, m.file_name,
             c.title as conversation_title, c.type as conversation_type
      FROM watch_later wl
      LEFT JOIN messages m ON wl.message_id = m.id
      LEFT JOIN conversations c ON wl.conversation_id = c.id
      WHERE wl.user_id = ? AND (m.burn_at IS NULL OR m.burn_at > ?)
    `
    const params = [userId, Date.now()]

    if (beforeId) {
      sql += ' AND wl.id < ?'
      params.push(Number(beforeId))
    }

    sql += ' ORDER BY wl.id DESC LIMIT ?'
    params.push(Number(limit))

    const rows = await q.all(sql, ...params)

    // 获取总数
    const { total } = await q.get('SELECT COUNT(*) as total FROM watch_later WHERE user_id = ?', userId)

    res.json({
      items: rows.map((row) => ({ ...row, content: row.content_encrypted ? decryptMessageText(row.content) : row.content })),
      total,
      hasMore: rows.length === Number(limit),
    })
  } catch (err) {
    next(err)
  }
})

// 添加到稍后看
router.post('/', authRequired, async (req, res, next) => {
  try {
    const userId = req.user.id
    const { messageId, conversationId } = req.body

    if (!messageId || !conversationId) {
      return res.status(400).json({ error: '缺少 messageId 或 conversationId' })
    }

    // 检查是否已存在（幂等：重复点「稍后看」不该多出一行）
    const existing = await q.get(
      'SELECT id FROM watch_later WHERE user_id = ? AND message_id = ?',
      userId,
      messageId
    )

    if (existing) {
      return res.json({ created: false, id: existing.id })
    }

    /* 用 insert() 拿自增 id —— 别再用 `result.lastInsertRowid`：
       PG 没有这个东西（那边靠 RETURNING id），`insert()` 会把两种驱动抹平。 */
    const id = await insert(
      'INSERT INTO watch_later (user_id, message_id, conversation_id) VALUES (?, ?, ?)',
      userId,
      messageId,
      conversationId
    )

    res.status(201).json({ created: true, id })
  } catch (err) {
    next(err)
  }
})

// 从稍后看移除
router.delete('/:id', authRequired, async (req, res, next) => {
  try {
    const userId = req.user.id
    const { id } = req.params

    const result = await q.run('DELETE FROM watch_later WHERE id = ? AND user_id = ?', id, userId)

    if (result.changes === 0) {
      return res.status(404).json({ error: '稍后看记录不存在' })
    }

    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// 按消息 ID 移除（用于取消稍后看）
router.delete('/message/:messageId', authRequired, async (req, res, next) => {
  try {
    const userId = req.user.id
    const { messageId } = req.params

    const result = await q.run('DELETE FROM watch_later WHERE message_id = ? AND user_id = ?', messageId, userId)

    res.json({ ok: true, deleted: result.changes > 0 })
  } catch (err) {
    next(err)
  }
})

export default router
