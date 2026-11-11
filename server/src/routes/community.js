/**
 * /api/v1/communities —— 社群（群聊聚合）
 *
 * 路由层只做三件事：取 `req.user.id`、校验参数、转 camelCase。
 * 业务逻辑全在 `community.js`。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { discoverableGroups, joinGroup } from '../community.js'

const r = Router()
r.use(authRequired)

/** 正整数参数，非法就退回默认值 —— 别让 `?limit=abc` 把 SQL 拖垮 */
function intParam(v, def, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(n, max)
}

r.get('/', async (req, res) => {
  res.json(await discoverableGroups({ viewerId: req.user.id, limit: intParam(req.query.limit, 20, 50) }))
})

r.post('/:id/join', async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '群 id 非法' })
  const out = await joinGroup({ viewerId: req.user.id, groupId: id })
  res.json({ ok: true, ...out })
})

export default r
