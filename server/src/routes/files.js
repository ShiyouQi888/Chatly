import { Router } from 'express'
import { authRequired } from '../auth.js'
import { q } from '../db.js'
import path from 'node:path'
import { PRIVATE_UPLOAD_DIR } from '../upload.js'

const router = Router()

router.get('/private/:filename', authRequired, async (req, res, next) => {
  const filename = String(req.params.filename || '')
  if (!filename || path.basename(filename) !== filename) return res.sendStatus(404)
  const url = `/api/v1/files/private/${filename}`
  try {
    const allowed = await q.get(
      `SELECT 1 FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
       WHERE m.file_url = ? AND cm.user_id = ? AND (m.burn_at IS NULL OR m.burn_at > ?) LIMIT 1`,
      url, req.user.id, Date.now()
    )
    if (!allowed) return res.sendStatus(404)
    const audioMime = {
      '.m4a': 'audio/mp4',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/ogg',
      '.wav': 'audio/wav',
      '.webm': 'audio/webm',
    }[path.extname(filename).toLowerCase()]
    if (audioMime) res.type(audioMime)
    res.sendFile(path.join(PRIVATE_UPLOAD_DIR, filename), (err) => { if (err && !res.headersSent) next(err) })
  } catch (e) {
    next(e)
  }
})

/* ===== 最近文件 =====
 * 扫描 messages 表中的文件/图片/视频消息，按时间倒序返回。
 * 支持按类型筛选和分页。 */

router.get('/', authRequired, async (req, res, next) => {
  try {
    const userId = req.user.id
    const { beforeId, type = 'all' } = req.query
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    const conversationId = req.query.conversationId ? Number(req.query.conversationId) : null

    if (req.query.conversationId && (!Number.isSafeInteger(conversationId) || conversationId <= 0)) {
      return res.status(400).json({ error: '群聊 ID 无效' })
    }
    if (conversationId) {
      const member = await q.get(
        `SELECT c.type FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE c.id = ? AND cm.user_id = ?`,
        conversationId, userId
      )
      if (!member || member.type !== 'group') return res.status(404).json({ error: '群聊不存在或你已不在群里' })
    }

    /* 构建类型过滤。
       ⚠️ 这里的 `LIKE` 在 PG 侧会被 db/sql.js 翻成 `ILIKE` —— 这是**故意的**：
       SQLite 的 LIKE 对 ASCII 本来就不区分大小写，PG 区分。
       不翻的话 `.ZIP` 文件在 SQLite 上查得到、在 PG 上查不到。 */
    let kindFilter = ''
    if (type === 'document') {
      kindFilter = "AND m.kind = 'file' AND (m.file_name LIKE '%.pdf' OR m.file_name LIKE '%.doc' OR m.file_name LIKE '%.docx' OR m.file_name LIKE '%.xls' OR m.file_name LIKE '%.xlsx' OR m.file_name LIKE '%.ppt' OR m.file_name LIKE '%.pptx' OR m.file_name LIKE '%.txt' OR m.file_name LIKE '%.csv' OR m.file_name LIKE '%.md' OR m.file_name LIKE '%.rtf')"
    } else if (type === 'image') {
      kindFilter = "AND m.kind = 'image'"
    } else if (type === 'video') {
      kindFilter = "AND m.kind = 'video'"
    } else if (type === 'archive') {
      // 压缩包：file_name 以 .zip/.rar/.7z 结尾
      kindFilter = "AND m.kind = 'file' AND (m.file_name LIKE '%.zip' OR m.file_name LIKE '%.rar' OR m.file_name LIKE '%.7z')"
    } else if (type === 'other') {
      // 其他：排除图片、视频、常见文档和压缩包，保留音频等文件类型
      kindFilter = "AND m.kind = 'file' AND m.file_name NOT LIKE '%.zip' AND m.file_name NOT LIKE '%.rar' AND m.file_name NOT LIKE '%.7z' AND m.file_name NOT LIKE '%.pdf' AND m.file_name NOT LIKE '%.doc' AND m.file_name NOT LIKE '%.docx' AND m.file_name NOT LIKE '%.xls' AND m.file_name NOT LIKE '%.xlsx' AND m.file_name NOT LIKE '%.ppt' AND m.file_name NOT LIKE '%.pptx' AND m.file_name NOT LIKE '%.txt' AND m.file_name NOT LIKE '%.csv' AND m.file_name NOT LIKE '%.md' AND m.file_name NOT LIKE '%.rtf'"
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
        AND (m.burn_at IS NULL OR m.burn_at > ?)
        ${kindFilter}
        ${conversationId ? 'AND m.conversation_id = ?' : ''}
        ${beforeId ? 'AND m.id < ?' : ''}
      ORDER BY m.id DESC
      LIMIT ?
    `

    const params = [userId, Date.now()]
    if (conversationId) params.push(conversationId)
    if (beforeId) params.push(Number(beforeId))
    params.push(limit)

    const rows = await q.all(sql, ...params)

    // 获取总数（用于分页）
    const countSql = `
      SELECT COUNT(*) as total
      FROM messages m
      JOIN conversation_members cm ON m.conversation_id = cm.conversation_id AND cm.user_id = ?
      WHERE m.file_url IS NOT NULL
        AND m.revoked_at IS NULL
        AND (m.burn_at IS NULL OR m.burn_at > ?)
        ${kindFilter}
        ${conversationId ? 'AND m.conversation_id = ?' : ''}
    `
    const { total } = await q.get(countSql, userId, Date.now(), ...(conversationId ? [conversationId] : []))

    res.json({
      files: rows,
      total,
      hasMore: rows.length === limit,
    })
  } catch (err) {
    next(err)
  }
})

export default router
