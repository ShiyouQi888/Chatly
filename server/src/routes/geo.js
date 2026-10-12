/**
 * /api/v1/geo —— 位置服务（腾讯位置服务的服务端代理）
 *
 * 为什么要有这一层：前端拿不到 key（也不该拿到），并且要用「有 key / 没 key」
 * 两种状态给前端一个**明确的降级信号**，而不是让前端去猜。
 *
 * 约定：**没配 key 时一律 200 + `{ configured: false }`**，不是 4xx/5xx。
 * 没配 key 是正常状态，不是错误 —— 用错误码表达的话，前端只能靠 catch 去判断，
 * 最后一定会写成「出错了就假装没这功能」，那是假功能。
 */
import { Router } from 'express'
import { authRequired } from '../auth.js'
import { isGeoConfigured, reverseGeocode } from '../geo.js'

const r = Router()
r.use(authRequired)

/** 前端启动时问一次「这一层到底通不通」，好决定要不要把地图/定位入口画出来。 */
r.get('/status', (_req, res) => {
  res.json({ configured: isGeoConfigured() })
})

/**
 * 坐标 → 地址（+ 附近地点）。
 * GET /api/v1/geo/locate?lat=22.54&lng=114.05&radius=1000&pois=1
 */
r.get('/locate', async (req, res) => {
  if (!isGeoConfigured()) {
    return res.json({
      configured: false,
      /* 说清楚为什么降级、以及降级之后前端还能做什么。
         前端据此显示「未配置位置服务」并保留手输，而不是给一个假地址。 */
      reason: '服务端未配置 TENCENT_MAP_KEY',
    })
  }

  const lat = Number(req.query.lat)
  const lng = Number(req.query.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: '缺少合法的经纬度（lat / lng）' })
  }

  try {
    const out = await reverseGeocode(lat, lng, {
      pois: req.query.pois !== '0',
      radius: req.query.radius ? Number(req.query.radius) : 1000,
    })
    res.json(out)
  } catch (e) {
    if (e.code === 'BAD_INPUT') return res.status(400).json({ error: e.message })
    /* 上游挂了 / 网络不通 / key 被拒 —— 如实回 502，把腾讯的原文带出去便于排查。
       不要吞掉改成「暂无数据」，那样用户看到的是一片空白而不是「服务有问题」。 */
    res.status(502).json({ error: e.message, code: e.code || 'UPSTREAM' })
  }
})

export default r
