import { Router } from 'express'
import { authRequired } from '../auth.js'
import { pushConfig, removePushSubscription, savePushSubscription } from '../push.js'

const router = Router()
router.use(authRequired)
router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

router.get('/config', (_req, res) => res.json(pushConfig()))

router.put('/subscription', async (req, res) => {
  try {
    /* ⚠️ 必须带上 deviceId：多端推送要按设备判定「这台设备在线就不推给它」。
       少了这个参数，订阅就只能按「用户级」处理 —— 那在多端场景下是错的
       （一台设备在线会吞掉其它设备的通知）。 */
    res.json(await savePushSubscription(req.user.id, req.body, req.deviceId))
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || '无法保存推送设置' })
  }
})

router.delete('/subscription', async (req, res) => {
  const endpoint = req.body?.endpoint
  if (typeof endpoint !== 'string' || !endpoint) return res.status(400).json({ error: '缺少推送订阅地址' })
  res.json({ ok: await removePushSubscription(req.user.id, endpoint) })
})

export default router
