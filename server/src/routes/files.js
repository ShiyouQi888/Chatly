import { Router } from 'express'
import { authRequired } from '../auth.js'
import { db } from '../db.js'

const router = Router()

/* ===== 最近文件 =====
 * 扫描 messages 表中的文件/图片/视频消息，按时间倒序返回。
 * 支持按类型筛选和分页。 */

router.get('/', authRequired, (req, res, next) => {
  try {
    const userId = req.user.id
    const { limit = 20, beforeId, type = 'all' } = req.query

    // 构建类型过滤
    let kindFilter = ''
    if (type === 'document') {
      kindFilter = "AND m.kind = 'file'"
    } else if (type === 'image') {
      kindFilter = "AND m.kind = 'image'"
    } else if (type === 'video') {
      kindFilter = "AND m.kind = 'video'"
    } else if (type === 'archive') {
      // 压缩包：file_name 以 .zip/.rar/.7z 结尾
      kindFilter = "AND m.kind = 'file' AND (m.file_name LIKE '%.zip' OR m.file_name LIKE '%.rar' OR m.file_name LIKE '%.7z')"
    } else if (type === 'other') {
      // 其他：排除上述类型
      kindFilter = "AND m.kind = 'file' AND m.file_name NOT LIKE '%.zip' AND m.file_name NOT LIKE '%.rar' AND m.file_name NOT LIKE '%.7z'"
    }
    // type === 'all' 不加过滤

    const sql = `
      SELECT m.id, m.kind, m.content, m.file_url, m.file_name, m.file_size, m.created_at,
             c.id as conversation_id, c.title as conversation_title, c.type as conversation_type,
             u.nickname as sender_name
      FROM messages m
      JOIN conversation_members cm ON m.conversation_id = cm.conversation_id AND cm.user_id = ?
      JOIN conversations c ON m.conversation_id = c.id
      JOIN users u ON m.sender_id = u.id
      WHERE m.file_url IS NOT NULL
        AND m.revoked_at IS NULL
        ${kindFilter}
        ${beforeId ? 'AND m.id < ?' : ''}
      ORDER BY m.id DESC
      LIMIT ?
    `

    const params = [userId]
    if (beforeId) params.push(Number(beforeId))
    params.push(Number(limit))

    const rows = db.prepare(sql).all(...params)

    // 获取总数（用于分页）
    const countSql = `
      SELECT COUNT(*) as total
      FROM messages m
      JOIN conversation_members cm ON m.conversation_id = cm.conversation_id AND cm.user_id = ?
      WHERE m.file_url IS NOT NULL
        AND m.revoked_at IS NULL
        ${kindFilter}
    `
    const { total } = db.prepare(countSql).get(userId)

    res.json({
      files: rows,
      total,
      hasMore: rows.length === Number(limit),
    })
  } catch (err) {
    next(err)
  }
})

export default router
