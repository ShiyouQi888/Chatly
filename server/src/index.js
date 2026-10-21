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
import watchLaterRoutes from './routes/watch-later.js'
import fileRoutes from './routes/files.js'
import settingsRoutes from './routes/settings.js'
import devicesRoutes from './routes/devices.js'
import feedbackRoutes from './routes/feedback.js'
import notificationRoutes from './routes/notifications.js'
import statusRoutes from './routes/statuses.js'
import adminRoutes from './routes/admin.js'
import { attachWs } from './ws.js'
import { q, ready, info } from './db.js'
import { authRequired } from './auth.js'
import { ready as redisReady, status as redisStatus, close as redisClose } from './redis.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3002
const HOST = process.env.HOST || '127.0.0.1'
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || 0

const app = express()
if (Number.isInteger(TRUST_PROXY_HOPS) && TRUST_PROXY_HOPS > 0) app.set('trust proxy', TRUST_PROXY_HOPS)
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// 聊天附件只允许会话成员读取；头像、动态媒体等其余上传仍走公开静态资源。
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
app.use('/uploads', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const assetPath = `/uploads${req.path}`
  const referenced = await q.get('SELECT 1 FROM messages WHERE file_url = ? LIMIT 1', assetPath)
  if (!referenced) return next()
  authRequired(req, res, () => {
    void q.get(
      `SELECT 1 FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
       WHERE m.file_url = ? AND cm.user_id = ? AND (m.burn_at IS NULL OR m.burn_at > ?) LIMIT 1`,
      assetPath, req.user.id, Date.now()
    ).then((allowed) => {
      if (!allowed) return res.sendStatus(404)
      const name = path.basename(req.path)
      if (!name || name !== req.path.slice(1)) return res.sendStatus(404)
      res.sendFile(path.join(UPLOAD_DIR, name), (err) => { if (err && !res.headersSent) next(err) })
    }).catch(next)
  })
})
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  },
}))

/* ---------- 健康检查 ---------- */
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'chatly-server',
    uptime: Math.round(process.uptime()),
    /* 把数据层与 Redis 的实际状态报出来 —— 「已降级」这件事必须能被看见，
       否则「本机没起 Redis」会一直伪装成「线上也是单进程」。 */
    db: info(),
    redis: redisStatus(),
  })
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
app.use('/api/v1/watch-later', watchLaterRoutes)
app.use('/api/v1/files', fileRoutes)
app.use('/api/v1/settings', settingsRoutes)
app.use('/api/v1/devices', devicesRoutes)
app.use('/api/v1/feedback', feedbackRoutes)
app.use('/api/v1/notifications', notificationRoutes)
app.use('/api/v1/statuses', statusRoutes)
app.use('/api/v1/admin', adminRoutes)

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

/* ⚠️ 先 `await ready()` 再 listen —— **早失败**。
   SQLite 是 import 时就建好表的（ready 是空实现），PG 则要等第一次连接建表 + 迁移。
   不在这里等的话，「DATABASE_URL 写错 / PG 没起来」会变成一个**启动成功、每个接口都 500**
   的服务 —— 那比启动时直接报错难查得多。 */
try {
  await ready()
} catch (e) {
  console.error(`\n  数据层初始化失败（${info().driver}）：${e.message}\n`)
  process.exit(1)
}

/* Redis 与数据层**相反**：连不上不阻塞启动，直接降级为单进程。
   理由：它是「跨实例」的增强，不是核心能力 —— 本地开发没起容器是完全正常的状态，
   为了它启动失败会把 22 支自检全部打死。降级的事实会打到日志，也能从 /health 查到。 */
await redisReady()

/* 到期消息会同时从收藏和通知快照清除，避免阅后即焚内容经副本继续保留。 */
const burnCleanup = setInterval(async () => {
  try {
    const now = Date.now()
    await q.run('DELETE FROM favorites WHERE message_id IN (SELECT id FROM messages WHERE burn_at IS NOT NULL AND burn_at <= ?)', now)
    await q.run("DELETE FROM notifications WHERE ref_id IN (SELECT id FROM messages WHERE burn_at IS NOT NULL AND burn_at <= ?) AND kind IN ('message','mention')", now)
    await q.run('DELETE FROM messages WHERE burn_at IS NOT NULL AND burn_at <= ?', now)
  } catch (error) {
    console.error('[messages] 阅后即焚清理失败:', error.message)
  }
}, 5000)
burnCleanup.unref()
const statusCleanup = setInterval(() => {
  void q.run('DELETE FROM user_statuses WHERE expires_at <= ?', Date.now()).catch((error) => {
    console.error('[statuses] 过期状态清理失败:', error.message)
  })
}, 60_000)
statusCleanup.unref()

server.listen(PORT, HOST, async () => {
  const n = (await q.get('SELECT COUNT(*) AS n FROM users'))?.n ?? 0
  const rs = redisStatus()
  console.log(`\n  Chatly 后端已启动`)
  console.log(`  REST  http://${HOST}:${PORT}/api/v1`)
  console.log(`  WS    ws://${HOST}:${PORT}/ws`)
  console.log(`  数据库 ${info().driver}${info().file ? ` (${info().file})` : ''}`)
  console.log(
    `  Redis ${
      rs.state === 'on'
        ? `已连接 ${rs.url}`
        : rs.configured
          ? `不可用，已降级为单进程`
          : `未配置（单进程内存模式）`
    }`
  )
  console.log(`  用户数 ${n}\n`)
})

/* 优雅退出：Redis 的两条连接和 PG 的池子都不会自己关。
   不关的话 Ctrl+C 之后进程可能还挂着几秒，看起来像「杀不掉」。 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void redisClose()
    server.close(() => process.exit(0))
    // 兜底：连接迟迟不关也不能一直卡着
    setTimeout(() => process.exit(0), 1500).unref()
  })
}

export default app
