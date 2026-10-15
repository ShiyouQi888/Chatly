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
 *
 * ## 两层在线的分工（Redis 是可选的，见 redis.js）
 *   - `online`（本进程的 Map）永远是**权威快路径**：判断「在不在线」先看它，零成本、同步。
 *   - Redis 只补两件 Map 做不到的事：① 多实例时「别人那台机器上的我在线吗」；
 *     ② 把事件送到挂在别的实例上的连接。
 *   - 没配 `REDIS_URL` 或 Redis 挂了 → 退回纯单进程行为，**功能不缺、只是不跨实例**。
 *
 * ## presence 只发给「和我有共同会话的人」
 * 以前是广播给所有在线连接。那等于告诉所有人「陈墨上线了」——
 * 对一个主打隐私的 App 来说这是白送的泄露。现在收窄到 `peersOf(userId)`。
 */
import { WebSocketServer } from 'ws'
import { q } from './db.js'
import { verifyToken } from './auth.js'
import { memberIds } from './chat.js'
import { peersOf } from './profile.js'
import { privacyOf, onlineVisible } from './privacy.js'
import { markLocalPresence, publishTo, onRemoteEvent, remotePresent, isEnabled as redisOn } from './redis.js'

/** userId -> Set<WebSocket> */
const online = new Map()

export function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  /* 别的实例发来的事件：只投给**挂在本实例**上的那几条连接。
     不会重复投 —— redis.js 的订阅端会跳过 origin 是自己实例的消息，
     而本实例的本地投递在下面 `broadcastToUsers` 里已经立即做过了。 */
  const offRemote = onRemoteEvent((ev) => {
    for (const id of ev.targets) {
      const set = online.get(Number(id))
      if (!set) continue
      for (const ws of set) send(ws, ev.type, ev.payload)
    }
  })

  wss.on('connection', (ws, req) => {
    void acceptSocket(ws, req).catch((e) => {
      console.warn('[ws] 鉴权失败：', e.message)
      try { ws.close(1011, 'authentication failed') } catch {}
    })
  })

  // 心跳，清理死连接
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      void q.get('SELECT 1 FROM user_devices WHERE id = ? AND user_id = ?', ws.deviceId, ws.userId)
        .then((session) => { if (!session) ws.close(4001, 'session revoked') })
        .catch((e) => console.warn('[ws] 会话检查失败：', e.message))
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)

  wss.on('close', () => {
    clearInterval(timer)
    offRemote()
  })

  return wss
}

async function acceptSocket(ws, req) {
    const url = new URL(req.url, 'http://localhost')
    const payload = verifyToken(url.searchParams.get('token') || '')
    const session = payload?.sid
      ? await q.get('SELECT id FROM user_devices WHERE session_id = ? AND user_id = ?', payload.sid, payload.sub)
      : null
    if (!payload || !session) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'token 无效' } }))
      ws.close(4001, 'unauthorized')
      return
    }
    if (ws.readyState !== 1) return

    const userId = Number(payload.sub)
    ws.userId = userId
    ws.deviceId = session.id
    ws.isAlive = true

    if (!online.has(userId)) online.set(userId, new Set())
    online.get(userId).add(ws)
    markLocalPresence(userId, true)

    send(ws, 'hello', { userId })
    void announcePresence(userId, true)

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
        /* 成员表是异步查的，所以真正的工作放在一个独立 async 函数里，
           而不是把 `ws.on('message')` 的回调标成 async —— 后者抛出来的错
           会变成一个**没人接的 promise rejection**，在 WS 场景里就是悄无声息。
           `void` 明确表示「不关心它的完成」。 */
        void relayTyping(userId, Number(msg.conversationId))
      }
    })

    ws.on('close', () => {
      const set = online.get(userId)
      if (set) {
        set.delete(ws)
        if (set.size === 0) {
          online.delete(userId)
          markLocalPresence(userId, false)
          void announcePresence(userId, false)
        }
      }
    })

    ws.on('error', () => {
      try {
        ws.close()
      } catch {}
    })
}

/* ================= 推送 API ================= */
function send(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }))
}

/** Close active local sockets after a device session is revoked. */
export function revokeDeviceSockets(userId, deviceId) {
  for (const ws of online.get(Number(userId)) || []) {
    if (ws.deviceId === Number(deviceId)) ws.close(4001, 'session revoked')
  }
}

/**
 * 「正在输入」的中转：确认发送者确实在这个会话里，再转发给其余成员。
 * 单独抽成 async 函数（见上面 `void relayTyping(...)` 的说明），
 * 并且**自己吞掉异常** —— 一次 typing 转发失败不该影响任何人的连接。
 */
async function relayTyping(userId, conversationId) {
  try {
    if (!conversationId) return
    const ids = await memberIds(conversationId)
    if (!ids.includes(userId)) return
    for (const id of ids) {
      if (id === userId) continue
      broadcastToUser(id, 'typing', { conversationId, userId })
    }
  } catch (e) {
    console.warn('[ws] typing 转发失败（已忽略）：', e.message)
  }
}

/**
 * 投给某个用户**在本实例上**的连接。
 * 返回值是「本实例投了几条」—— 跨实例的投递是异步发到 Redis 的，不计入这个数，
 * 所以调用方不要拿它当「送达确认」用（原来也没有这个语义）。
 */
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
 *
 * 两步：先在本实例立刻投一次（不等 Redis 往返），再把同一条事件 publish 出去，
 * 让挂在别的实例上的连接也能收到。origin 去重保证不会投两遍。
 */
export function broadcastToUsers(userIds, type, payload) {
  const ids = [...new Set(userIds.map(Number))]
  for (const id of ids) broadcastToUser(id, type, payload)
  publishTo(ids, type, payload)
}

/**
 * 上/下线通知。
 *
 * 两道收窄，缺一不可：
 *   ① 只在对方**允许别人看到自己的在线状态**时才发。关了就不发 ——
 *      「一直显示离线」和「对方关掉了在线状态」在界面上是一回事，
 *      发 `online:false` 只是白告诉别人「这个人存在但故意藏着」。
 *   ② 只发给和 Ta 有共同会话的人。原来广播给所有在线连接，
 *      等于给每个陌生人白送一条「陈墨上线了」。
 *
 * 自己吞异常：一次 presence 查询失败不该把连接带崩。
 */
async function announcePresence(userId, onlineFlag, { force = false } = {}) {
  try {
    if (!force && !onlineVisible(await privacyOf(userId))) return
    const peers = (await peersOf(userId)).filter((id) => Number(id) !== Number(userId))
    if (!peers.length) return
    broadcastToUsers(peers, 'presence', { userId, online: onlineFlag })
  } catch (e) {
    console.warn('[ws] presence 广播失败（已忽略）：', e.message)
  }
}

/**
 * 「在线状态可见」这个开关被拨动时**立刻**同步一次。
 *
 * 不做这一步的话要等用户重连才生效，中间这段时间朋友那边显示的是旧状态：
 * 关了还显示在线、开了还显示离线。两者都是「设置看着是真的、其实没生效」。
 *
 * ⚠️ 关掉时走 `force`：这一条是在**纠正**一个我们已经披露过的状态，
 * 不是新的披露 —— 不 force 的话会被自己的 `onlineVisible` 检查挡掉，
 * 于是「一直显示在线」。
 */
export function broadcastVisibilityToggle(userId, visible) {
  return syncVisibility(userId, visible)
}

async function syncVisibility(userId, visible) {
  try {
    if (!visible) {
      /* 关掉：这是一次**纠正** —— 我们刚才还告诉过别人他在线，现在要把它收回来。
         不 force 的话会被自己的 `onlineVisible` 检查挡掉，于是「关了还显示在线」。 */
      await announcePresence(userId, false, { force: true })
      return
    }
    /* 打开：**不能**直接宣布「在线」。
       用户很可能是关了之后一直没用（压根没连上），无条件报 online:true
       会让朋友那边看到一个假的在线圆点 —— 比「没反应」更糟。
       要报的是他**此刻真实的状态**。 */
    await announcePresence(userId, await isOnlineAnywhere(userId))
  } catch (e) {
    console.warn('[ws] 在线状态开关同步失败（已忽略）：', e.message)
  }
}

/* ================= 在线状态查询 ================= */

/** 只问**本实例**（同步、零成本）。内部快路径用它。 */
export function isOnline(userId) {
  return online.has(Number(userId))
}

/**
 * 「任意实例上在线吗」—— 本地 Map 先看，没命中再问 Redis。
 * ⚠️ 这是 async 的，只在本来就 async 的出参拼装里用（资料页 / 列表页）。
 */
export async function isOnlineAnywhere(userId) {
  const id = Number(userId)
  if (!id) return false
  if (online.has(id)) return true
  if (!redisOn()) return false
  return (await remotePresent([id])).has(id)
}

/**
 * 批量版（列表页用）。逐个人 `await isOnlineAnywhere` 在 PG + Redis 下
 * 就是 N 次 Redis 往返；这里合成一次 pipeline。
 */
export async function onlineSetOf(userIds) {
  const ids = [...new Set((userIds || []).map(Number))].filter(Boolean)
  const out = new Set(ids.filter((id) => online.has(id)))
  if (!redisOn()) return out
  for (const id of await remotePresent(ids)) out.add(id)
  return out
}

export function onlineUserIds() {
  return [...online.keys()]
}
