import { Router } from 'express'
import { db } from '../db.js'
import { authRequired } from '../auth.js'

const router = Router()

// 获取用户的所有设备
router.get('/', authRequired, (req, res) => {
  const userId = req.user.id
  const devices = db.prepare(`
    SELECT id, device_name, device_type, last_active, is_current, created_at
    FROM user_devices
    WHERE user_id = ?
    ORDER BY is_current DESC, last_active DESC
  `).all(userId)
  
  res.json(devices.map(d => ({
    id: d.id,
    name: d.device_name,
    type: d.device_type,
    lastActive: d.last_active,
    isCurrent: d.is_current === 1,
    createdAt: d.created_at
  })))
})

// 删除设备（远程退出）
router.delete('/:id', authRequired, (req, res) => {
  const userId = req.user.id
  const deviceId = parseInt(req.params.id)
  
  // 不能删除当前设备
  const device = db.prepare('SELECT is_current FROM user_devices WHERE id = ? AND user_id = ?').get(deviceId, userId)
  if (!device) {
    return res.status(404).json({ error: '设备不存在' })
  }
  if (device.is_current === 1) {
    return res.status(400).json({ error: '不能删除当前登录设备' })
  }
  
  db.prepare('DELETE FROM user_devices WHERE id = ? AND user_id = ?').run(deviceId, userId)
  res.json({ success: true })
})

// 更新安全设置（生物识别、二次验证等）
router.put('/settings', authRequired, (req, res) => {
  const userId = req.user.id
  const { biometric, twoFactor } = req.body
  
  const stmt = db.prepare(`
    INSERT INTO user_settings (user_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `)
  
  const transaction = db.transaction(() => {
    if (biometric !== undefined) {
      stmt.run(userId, 'security_biometric', biometric ? '1' : '0')
    }
    if (twoFactor !== undefined) {
      stmt.run(userId, 'security_two_factor', twoFactor ? '1' : '0')
    }
  })
  
  transaction()
  res.json({ success: true })
})

// 获取安全设置
router.get('/settings', authRequired, (req, res) => {
  const userId = req.user.id
  const settings = db.prepare(`
    SELECT key, value FROM user_settings
    WHERE user_id = ? AND key IN ('security_biometric', 'security_two_factor')
  `).all(userId)
  
  const result = {
    biometric: false,
    twoFactor: false
  }
  
  settings.forEach(s => {
    if (s.key === 'security_biometric') result.biometric = s.value === '1'
    if (s.key === 'security_two_factor') result.twoFactor = s.value === '1'
  })
  
  res.json(result)
})

export default router
