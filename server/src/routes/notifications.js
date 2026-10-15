/**
 * /api/v1/notifications —— 通知中心的数据源
 *
 * 这一组接口是「消息通知」那一页从「整页禁用」变成真实功能的另一半：
 * 没有它们，前端就算想显示也得回去读 mock。
 *
 * 偏好（notify_* / sound / dnd_*）读写都**复用 /settings** 那一对路由 ——
 * 那里已经是 key-value 通用存储，再开一套「通知偏好专用接口」
 * 就会出现同一份数据两个写入点，两边各自缓存、迟早打架。
 * 这里只额外提供 GET /prefs（合并默认值后的形状），省得前端自己拼默认值。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import {
  listNotifications,
  unreadCount,
  markNotificationsRead,
  notifyPrefsOf,
} from '../notification.js'

const r = Router()
r.use(authRequired)

/** 列表。?group=all|chat|interact|system &beforeId &limit */
r.get('/', async (req, res) => {
  const { beforeId, limit, group } = req.query
  res.json(await listNotifications(req.user.id, { beforeId, limit, group }))
})

/** 未读数 —— 入口红点单独一个轻接口，不用为了一个数字把 30 条拉下来 */
r.get('/unread', async (req, res) => {
  res.json({ unread: await unreadCount(req.user.id) })
})

/**
 * 通知偏好（已合并默认值）。
 * 写入走 `PUT /settings`（批量）或 `PUT /settings/:key`（单键），
 * 那些路由早就存在、也已经处理了 JSON 序列化 —— 不在这里重复一份。
 */
r.get('/prefs', async (req, res) => {
  res.json(await notifyPrefsOf(req.user.id))
})

/**
 * 标记已读。body: { ids?: number[] } —— 不传 ids 就是「全部」。
 * 越权防护在 notification.js 的 markNotificationsRead 里（WHERE 一定带 user_id）。
 */
r.post('/read', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null
  res.json({ ok: true, affected: await markNotificationsRead(req.user.id, ids) })
})

export default r
