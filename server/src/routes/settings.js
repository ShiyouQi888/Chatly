import { Router } from 'express'
import { db } from '../db.js'
import { authRequired } from '../auth.js'

const router = Router()

// 获取用户设置
router.get('/', authRequired, (req, res) => {
  const userId = req.user.id
  const settings = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId)
  
  const result = {}
  settings.forEach(s => {
    try {
      result[s.key] = JSON.parse(s.value)
    } catch {
      result[s.key] = s.value
    }
  })
  
  res.json(result)
})

// 更新单个设置
router.put('/:key', authRequired, (req, res) => {
  const userId = req.user.id
  const { key } = req.params
  const { value } = req.body
  
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
  
  db.prepare(`
    INSERT INTO user_settings (user_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, key, valueStr)
  
  res.json({ success: true })
})

// 批量更新设置
router.put('/', authRequired, (req, res) => {
  const userId = req.user.id
  const settings = req.body
  
  const stmt = db.prepare(`
    INSERT INTO user_settings (user_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `)
  
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
      stmt.run(userId, key, valueStr)
    }
  })
  
  transaction()
  res.json({ success: true })
})

export default router
