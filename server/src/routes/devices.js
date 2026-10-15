/**
 * /api/v1/devices —— 登录设备管理与安全设置
 *
 * ⚠️ 原来是 `db.prepare(...)` 直连 SQLite（`db.transaction()` 也一样）。
 *    那在 PG 模式下会撞上门面里那个「一碰就报错」的代理 ——
 *    现在统一走 `q.*` / `tx()`，两种驱动都能跑。
 */
import { Router } from 'express'
import { q, tx } from '../db.js'
import { authRequired } from '../auth.js'
import { revokeDeviceSockets } from '../ws.js'

const router = Router()

// 获取用户的所有设备
router.get('/', authRequired, async (req, res) => {
  const userId = req.user.id
  const devices = await q.all(
    `SELECT id, device_name, device_type, session_id, last_active, created_at
       FROM user_devices
      WHERE user_id = ?
      ORDER BY is_current DESC, last_active DESC`,
    userId
  )

  res.json(
    devices.map((d) => ({
      id: d.id,
      name: d.device_name,
      type: d.device_type,
      lastActive: d.last_active,
      isCurrent: d.id === req.deviceId,
      createdAt: d.created_at,
    }))
  )
})

// 删除设备（远程退出）
router.delete('/:id', authRequired, async (req, res) => {
  const userId = req.user.id
  const deviceId = parseInt(req.params.id)

  // 不能删除当前设备
  const device = await q.get('SELECT id FROM user_devices WHERE id = ? AND user_id = ?', deviceId, userId)
  if (!device) {
    return res.status(404).json({ error: '设备不存在' })
  }
  if (deviceId === req.deviceId) {
    return res.status(400).json({ error: '不能删除当前登录设备' })
  }

  await q.run('DELETE FROM user_devices WHERE id = ? AND user_id = ?', deviceId, userId)
  revokeDeviceSockets(userId, deviceId)
  res.json({ success: true })
})

/* ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
   两边都支持（SQLite 3.24+ 的 UPSERT / PG 的 ON CONFLICT），
   目标正好是 user_settings 的主键 (user_id, key)，所以不需要方言翻译。 */
const UPSERT_SETTING = `
  INSERT INTO user_settings (user_id, key, value)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
`

// 更新安全设置（生物识别、二次验证等）
router.put('/settings', authRequired, async (req, res) => {
  const userId = req.user.id
  const { biometric, twoFactor } = req.body

  /* 两条 upsert 放一个事务里 —— 否则「生物识别写成功、二次验证写失败」会留下
     一个只改了一半的设置，而界面上两次开关都显示成了新值。 */
  await tx(async () => {
    if (biometric !== undefined) {
      await q.run(UPSERT_SETTING, userId, 'security_biometric', biometric ? '1' : '0')
    }
    if (twoFactor !== undefined) {
      await q.run(UPSERT_SETTING, userId, 'security_two_factor', twoFactor ? '1' : '0')
    }
  })

  res.json({ success: true })
})

// 获取安全设置
router.get('/settings', authRequired, async (req, res) => {
  const userId = req.user.id
  const settings = await q.all(
    `SELECT key, value FROM user_settings
      WHERE user_id = ? AND key IN ('security_biometric', 'security_two_factor')`,
    userId
  )

  const result = {
    biometric: false,
    twoFactor: false,
  }

  settings.forEach((s) => {
    if (s.key === 'security_biometric') result.biometric = s.value === '1'
    if (s.key === 'security_two_factor') result.twoFactor = s.value === '1'
  })

  res.json(result)
})

export default router
