/**
 * Chatly 独立后端入口
 * REST: http://127.0.0.1:3002/api/v1
 * WS:   ws://127.0.0.1:3002/ws?token=<jwt>
 */
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import authRoutes from './routes/auth.js'
import conversationRoutes from './routes/conversations.js'
import messageRoutes from './routes/messages.js'
import userRoutes from './routes/users.js'
import momentRoutes from './routes/moments.js'
import discoverRoutes from './routes/discover.js'
import geoRoutes from './routes/geo.js'
import pollRoutes from './routes/polls.js'
import favoriteRoutes from './routes/favorites.js'
import { attachWs } from './ws.js'
import { db } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3002
const HOST = process.env.HOST || '127.0.0.1'

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// 上传产物静态托管
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
app.use('/uploads', express.static(UPLOAD_DIR))

/* ---------- 健康检查 ---------- */
app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'chatly-server', uptime: Math.round(process.uptime()) })
)

/* ---------- API ---------- */
app.use('/api/v1/auth', authRoutes)
app.use('/api/v1/conversations', conversationRoutes)
app.use('/api/v1/messages', messageRoutes)
app.use('/api/v1/users', userRoutes)
app.use('/api/v1/moments', momentRoutes)
app.use('/api/v1/discover', discoverRoutes)
app.use('/api/v1/geo', geoRoutes)
app.use('/api/v1/polls', pollRoutes)
app.use('/api/v1/favorites', favoriteRoutes)

/* ---------- 404 / 错误 ---------- */
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }))

app.use((err, _req, res, _next) => {
  console.error('[error]', err)
  // multer 的体积超限属于客户端问题，别报 500
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.name === 'MulterError' ? 400 : 500)
  const message =
    err.code === 'LIMIT_FILE_SIZE' ? '文件超过体积上限' : err.message || '服务器内部错误'
  res.status(status).json({ error: message })
})

/* ---------- 启动 ---------- */
const server = http.createServer(app)
attachWs(server)

server.listen(PORT, HOST, () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  console.log(`\n  Chatly 后端已启动`)
  console.log(`  REST  http://${HOST}:${PORT}/api/v1`)
  console.log(`  WS    ws://${HOST}:${PORT}/ws`)
  console.log(`  用户数 ${n}\n`)
})

export default app
