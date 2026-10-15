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
import { parseGeoPair } from '../../../shared/geo-math.mjs'

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
  /* ⚠️ 参数校验必须排在「有没有配 key」**前面**。
     反过来的话，没配 key 的机器上脏参数会被 200 放过，而配上 key 之后同一个请求变成 400 ——
     同一份客户端代码在两种环境下行为不同，而且这种差异**只有装上 key 那天才会暴露**。

     ⚠️ 也别自己写 `Number(req.query.lat)` 来判：`Number('') === 0`、`Number(null) === 0`，
     空参数会被当成合法的 (0, 0)，正好落在几内亚湾。
     统一走共享的 `parseGeoPair()`（成对 + 范围 + 空值一起管住）。 */
  const pair = parseGeoPair(req.query.lat, req.query.lng)
  if (!pair) return res.status(400).json({ error: '缺少合法的经纬度（lat / lng）' })

  if (!isGeoConfigured()) {
    return res.json({
      configured: false,
      /* 说清楚为什么降级、以及降级之后前端还能做什么。
         前端据此显示「未配置位置服务」并保留手输，而不是给一个假地址。 */
      reason: '服务端未配置 TENCENT_MAP_KEY',
    })
  }

  try {
    const out = await reverseGeocode(pair.lat, pair.lng, {
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
