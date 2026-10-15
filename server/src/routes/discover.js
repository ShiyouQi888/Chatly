/**
 * /api/v1/discover —— 发现页
 *
 * 路由层只做三件事：取 `req.user.id`、校验参数、转 camelCase。
 * 业务逻辑全在 `discover.js`。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import {
  recommendUsers,
  nearbyUsers,
  tagCloud,
  discoverableGroups,
  joinGroup,
  upcomingActivities,
  trendingTopics,
  recordTopicView,
} from '../discover.js'
import { listMoments } from '../moment.js'

const r = Router()
r.use(authRequired)

/** 正整数参数，非法就退回默认值 —— 别让 `?limit=abc` 把 SQL 拖垮 */
function intParam(v, def, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(n, max)
}

r.get('/recommend', async (req, res) => {
  const { users, hasMore } = await recommendUsers({
    viewerId: req.user.id,
    tag: String(req.query.tag || '').slice(0, 20),
    limit: intParam(req.query.limit, 20, 50),
    offset: intParam(req.query.offset, 0, 100000),
  })
  res.json({ users, hasMore })
})

r.get('/nearby', async (req, res) => {
  const { users, myRegion, myGeo } = await nearbyUsers({
    viewerId: req.user.id,
    limit: intParam(req.query.limit, 20, 50),
  })
  /* `myGeo` 只回「我的城市名」，**不回坐标** ——
     前端要的只是「要不要显示『按行政区划中心点估算』那句提示」。 */
  res.json({ users, myRegion, myGeo })
})

r.get('/tags', async (req, res) => {
  res.json(await tagCloud({ viewerId: req.user.id, limit: intParam(req.query.limit, 24, 60) }))
})

r.get('/groups', async (req, res) => {
  res.json(await discoverableGroups({ viewerId: req.user.id, limit: intParam(req.query.limit, 20, 50) }))
})

r.get('/activities', async (req, res) => {
  res.json(await upcomingActivities({ viewerId: req.user.id, limit: intParam(req.query.limit, 20, 50) }))
})

r.get('/topics', async (_req, res) => {
  res.json(await trendingTopics({ limit: 20 }))
})

r.post('/topics/:topic/view', async (req, res) => {
  try {
    res.json(await recordTopicView({ viewerId: req.user.id, topic: req.params.topic }))
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

r.get('/topics/:topic/moments', async (req, res) => {
  const topic = String(req.params.topic || '').trim().slice(0, 40)
  if (!topic) return res.status(400).json({ error: '话题不能为空' })
  res.json(await listMoments({ viewerId: req.user.id, scope: 'hot', topic, limit: intParam(req.query.limit, 20, 50) }))
})

r.post('/groups/:id/join', async (req, res) => {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '群 id 非法' })
  const out = await joinGroup({ viewerId: req.user.id, groupId: id })
  res.json({ ok: true, ...out })
})

export default r
