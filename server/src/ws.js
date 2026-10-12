/**
 * WebSocket 网关：鉴权、在线状态、消息实时投递
 *
 * 连接：ws://host/ws?token=<jwt>
 * 下行事件：{ type, payload }
 *   hello          — 连接就绪
 *   message.new    — 新消息
 *   message.revoked— 消息撤回
 *   conversation.read — 对方已读推进
 *   typing         — 对方正在输入
 *   presence       — 用户上/下线
 *   user.updated   — 同会话某人改了昵称/头像，前端据此刷新本地缓存
 *   conversation.updated — 群资料 / 成员变了
 *   poll.updated   — 群里有人投票 / 改票 / 结束投票，payload 是**整份投票**（见 polls.js）
 */
import { WebSocketServer } from 'ws'
import { verifyToken } from './auth.js'
import { memberIds } from './chat.js'

/** userId -> Set<WebSocket> */
const online = new Map()

export function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const payload = verifyToken(url.searchParams.get('token') || '')
    if (!payload) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'token 无效' } }))
      ws.close(4001, 'unauthorized')
      return
    }

    const userId = Number(payload.sub)
    ws.userId = userId
    ws.isAlive = true

    if (!online.has(userId)) online.set(userId, new Set())
    online.get(userId).add(ws)

    send(ws, 'hello', { userId })
    broadcastPresence(userId, true)

    ws.on('pong', () => (ws.isAlive = true))

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      // 目前仅处理 typing（发消息走 REST，便于落库与返回 id）
      if (msg.type === 'typing' && msg.conversationId) {
        const ids = memberIds(Number(msg.conversationId))
        if (!ids.includes(userId)) return
        for (const id of ids) {
          if (id === userId) continue
          broadcastToUser(id, 'typing', { conversationId: Number(msg.conversationId), userId })
        }
      }
    })

    ws.on('close', () => {
      const set = online.get(userId)
      if (set) {
        set.delete(ws)
        if (set.size === 0) {
          online.delete(userId)
          broadcastPresence(userId, false)
        }
      }
    })

    ws.on('error', () => {
      try {
        ws.close()
      } catch {}
    })
  })

  // 心跳，清理死连接
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)

  wss.on('close', () => clearInterval(timer))

  return wss
}

/* ================= 推送 API ================= */
function send(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }))
}

export function broadcastToUser(userId, type, payload) {
  const set = online.get(Number(userId))
  if (!set) return 0
  let n = 0
  for (const ws of set) {
    send(ws, type, payload)
    n++
  }
  return n
}

/**
 * 按「用户 id 列表」推送。
 * 注意：参数是 userIds，不是 conversationId —— 调用方负责把会话成员换成用户 id。
 */
export function broadcastToUsers(userIds, type, payload) {
  for (const id of new Set(userIds.map(Number))) broadcastToUser(id, type, payload)
}

function broadcastPresence(userId, onlineFlag) {
  // 只通知在线用户其好友状态；这里简化为广播给所有在线连接
  for (const [id, set] of online) {
    if (id === userId) continue
    for (const ws of set) send(ws, 'presence', { userId, online: onlineFlag })
  }
}

export function isOnline(userId) {
  return online.has(Number(userId))
}

export function onlineUserIds() {
  return [...online.keys()]
}
