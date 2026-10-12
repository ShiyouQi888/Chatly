/**
 * /api/v1/favorites —— 消息收藏（PRD §9「长按消息 → 收藏」「多选批量 → 收藏」）
 *
 * 分层保持一致：这里只做「取 req.user.id / 校验参数 / 转形状」，
 * 快照与判定全在 ../favorite.js。
 *
 * ## 两条授权规矩
 *
 * 1. **收藏是私人的。** 每条按 id 操作的 SQL 都带 `user_id = ?`（在 favorite.js 里），
 *    别人的收藏 id 猜到了也拿不到、删不掉。
 * 2. **收藏别人会话里的消息要挡住。** 消息 id 是自增的、很好猜，
 *    所以任何入口都先确认「这条消息所在的会话，调用方是成员」。
 *    这一步必须**先于**快照 —— 快照本身不做鉴权（它只认 messageId）。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { isMember } from '../chat.js'
import {
  addFavorite,
  addFavorites,
  removeFavorite,
  removeFavoriteByMessage,
  removeFavoritesByMessages,
  listFavorites,
  countFavorites,
  conversationOfMessage,
} from '../favorite.js'

const r = Router()
r.use(authRequired)

/** 业务层抛的是 `{status, message}`，没有 status 的是真 bug（交给错误中间件报 500） */
function fail(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.message })
  throw e
}

/**
 * 确认调用方有权碰这条消息。
 * 消息不存在 → 404（不是 403：不泄漏「这个 id 有没有消息」）。
 * 不是该会话成员 → 403。
 */
function assertCanAccess(userId, messageId) {
  const cid = conversationOfMessage(messageId)
  if (!cid) {
    const e = new Error('消息不存在')
    e.status = 404
    throw e
  }
  if (!isMember(cid, userId)) {
    const e = new Error('无权收藏该消息')
    e.status = 403
    throw e
  }
}

/* ---------- 列表 ---------- */
r.get('/', (req, res) => {
  const { beforeId, limit } = req.query
  const out = listFavorites(req.user.id, {
    beforeId: beforeId ? Number(beforeId) : null,
    limit,
  })
  /* total 一起给：我页统计条要真数，单独再发一次请求不值得 */
  res.json({ favorites: out.items, hasMore: out.hasMore, total: countFavorites(req.user.id) })
})

/* ---------- 收藏一条 ----------
   幂等：已经收藏过返回既有那一条（`created:false`），不报错。
   前端那个「收藏 / 取消收藏」是个开关，重复点不该炸。
   已撤回的消息由 favorite.js 抛 400（文案是「这条消息已撤回，不能收藏」）。 */
r.post('/', (req, res) => {
  const messageId = Number(req.body?.messageId)
  if (!messageId) return res.status(400).json({ error: '缺少 messageId' })
  try {
    assertCanAccess(req.user.id, messageId)
    const out = addFavorite(req.user.id, messageId)
    res.status(out.created ? 201 : 200).json({ favorite: out.favorite, created: out.created })
  } catch (e) {
    return fail(res, e)
  }
})

/* ---------- 批量收藏（多选模式） ----------
   **整批鉴权前置**：有一条不属于自己就整批拒（403），
   避免「部分成功」让前端的状态变得难解释。 */
r.post('/batch', (req, res) => {
  const ids = Array.from(new Set((req.body?.messageIds || []).map(Number).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ error: '请至少选择一条消息' })
  if (ids.length > 50) return res.status(400).json({ error: '一次最多收藏 50 条' })
  try {
    for (const id of ids) assertCanAccess(req.user.id, id)
    /* 逐条收藏：其中混着一条已撤回的，只跳过它、其余照收（skipped 里有原因）。
       整批失败会让用户「选了 10 条一条都没收藏上」，那他只会觉得功能坏了。 */
    const out = addFavorites(req.user.id, ids)
    res.json({ ...out, total: countFavorites(req.user.id) })
  } catch (e) {
    return fail(res, e)
  }
})

/* ---------- 取消收藏 ----------
   两种写法：`?messageId=`（消息气泡上的开关，手里只有 messageId）
   与 `/:id`（收藏列表里删那一条）。**都幂等** —— 没收藏过也回 ok，
   「取消失败」不是用户能处理的信息。 */
r.delete('/', (req, res) => {
  const messageId = Number(req.query.messageId)
  if (!messageId) return res.status(400).json({ error: '缺少 messageId' })
  const removed = removeFavoriteByMessage(req.user.id, messageId)
  res.json({ ok: true, removed, total: countFavorites(req.user.id) })
})

r.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '收藏 id 非法' })
  const removed = removeFavorite(req.user.id, id)
  res.json({ ok: true, removed, total: countFavorites(req.user.id) })
})

/* ---------- 批量取消（多选模式里对已收藏的那几条） ---------- */
r.post('/unbatch', (req, res) => {
  const ids = Array.from(new Set((req.body?.messageIds || []).map(Number).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ error: '请至少选择一条消息' })
  const removed = removeFavoritesByMessages(req.user.id, ids)
  res.json({ ok: true, removed, total: countFavorites(req.user.id) })
})

export default r
