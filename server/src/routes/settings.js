/**
 * /api/v1/settings —— 用户设置的 key-value 存储
 *
 * 值统一按 JSON 存（`value` 列是 TEXT）—— 读的时候 JSON.parse，失败就把原文当字符串。
 * 这样布尔 / 数字 / 对象都能原样往返，不用为每种类型各留一列。
 */
import { Router } from 'express'
import { q, tx } from '../db.js'
import { authRequired } from '../auth.js'
import { normalizePrivacyValue } from '../privacy.js'
import { broadcastVisibilityToggle, broadcastToUsers } from '../ws.js'
import { messageEncryptionConfigured } from '../message-crypto.js'

const router = Router()

/* ON CONFLICT(user_id, key) 指向 user_settings 的主键，SQLite 与 PG 的语义一致，
   不需要方言翻译（见 db/sql.js）。 */
const UPSERT_SETTING = `
  INSERT INTO user_settings (user_id, key, value)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
`

async function syncReadReceiptVisibility(userId, enabled) {
  const memberships = await q.all(
    'SELECT conversation_id AS conversationId, last_read_message_id AS cursor FROM conversation_members WHERE user_id = ?',
    userId
  )
  for (const membership of memberships) {
    const members = await q.all('SELECT user_id AS id FROM conversation_members WHERE conversation_id = ?', membership.conversationId)
    broadcastToUsers(members.map((m) => m.id), 'conversation.read', {
      conversationId: membership.conversationId,
      userId,
      lastReadMessageId: enabled ? Number(membership.cursor) || 0 : 0,
    })
  }
}

// 获取用户设置
router.get('/', authRequired, async (req, res) => {
  const userId = req.user.id
  const settings = await q.all('SELECT key, value FROM user_settings WHERE user_id = ?', userId)

  const result = {}
  settings.forEach((s) => {
    try {
      result[s.key] = JSON.parse(s.value)
    } catch {
      result[s.key] = s.value
    }
  })

  res.json(result)
})

// 更新单个设置
router.put('/:key', authRequired, async (req, res) => {
  const userId = req.user.id
  const { key } = req.params
  const { value } = req.body

  if (key === 'message_encryption' && value === true && !messageEncryptionConfigured()) {
    return res.status(503).json({ error: '服务端尚未配置消息加密密钥，暂时无法开启' })
  }

  const valueStr = typeof value === 'string' ? value : JSON.stringify(value)

  await q.run(UPSERT_SETTING, userId, key, valueStr)

  /* 需要立即改变他人可见状态的设置，在持久化后同步推送。 */
  if (key === 'online_status_visible') {
    broadcastVisibilityToggle(userId, normalizePrivacyValue(key, value))
  }
  if (key === 'read_receipts') await syncReadReceiptVisibility(userId, value !== false)

  res.json({ success: true })
})

// 批量更新设置
router.put('/', authRequired, async (req, res) => {
  const userId = req.user.id
  const settings = req.body

  if (settings?.message_encryption === true && !messageEncryptionConfigured()) {
    return res.status(503).json({ error: '服务端尚未配置消息加密密钥，暂时无法开启' })
  }

  /* 批量写必须在一个事务里 —— 中途失败时要么全成、要么全不成。
     否则「改了 5 个开关，第 3 个报错」，前两个已经落库了，界面却弹了个失败提示。 */
  await tx(async () => {
    for (const [key, value] of Object.entries(settings)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
      await q.run(UPSERT_SETTING, userId, key, valueStr)
    }
  })

  // 同单键更新：批量里带了这一项就同步一次（放在事务**之后** —— 广播不该在事务里做）
  if (settings.online_status_visible !== undefined) {
    broadcastVisibilityToggle(userId, normalizePrivacyValue('online_status_visible', settings.online_status_visible))
  }
  if (settings.read_receipts !== undefined) await syncReadReceiptVisibility(userId, settings.read_receipts !== false)

  res.json({ success: true })
})

export default router
