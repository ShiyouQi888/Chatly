/**
 * WebSocket 网关：鉴权、在线状态、消息实时投递
 *
 * 连接：先通过已认证 REST 获取一次性票据，再连接 ws://host/ws?ticket=<opaque-ticket>
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
 *   call.*         — 一对一语音邀请、接听状态与 WebRTC SDP / ICE 信令
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
import crypto from 'node:crypto'
import { q, tx } from './db.js'
import { memberIds, recordCallMessage } from './chat.js'
import { peersOf } from './profile.js'
import { privacyOf, onlineVisible } from './privacy.js'
import { markLocalPresence, publishTo, onRemoteEvent, remotePresent, isEnabled as redisOn } from './redis.js'
import { privatePairGate } from './friends.js'
import { hasPushSubscription, pushIsConfigured, sendPushToUser } from './push.js'

/** userId -> Set<WebSocket> */
const online = new Map()
let ticketSchemaReady
let voiceCallSchemaReady
const callExpiryTimers = new Map()
const CALL_RING_TIMEOUT = 90_000
const CALL_MAX_DURATION = 4 * 60 * 60 * 1000

async function ensureVoiceCallSchema() {
  if (!voiceCallSchemaReady) {
    voiceCallSchemaReady = (async () => {
      await q.run(`CREATE TABLE IF NOT EXISTS voice_calls (
        call_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        callee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('ringing', 'accepted', 'rejected', 'cancelled', 'ended', 'expired')),
        media TEXT NOT NULL DEFAULT 'audio',
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        started_at BIGINT,
        ended_at BIGINT,
        duration_sec INTEGER,
        end_reason TEXT
      )`)
      /* 老库补列。跨驱动只能用 try/catch —— SQLite 报 "duplicate column name"，
         PG 报 "column ... already exists"，两边都当成功处理，其余错误照抛。 */
      for (const [name, ddl] of [
        ['media', "TEXT NOT NULL DEFAULT 'audio'"],
        ['started_at', 'BIGINT'],
        ['ended_at', 'BIGINT'],
        ['duration_sec', 'INTEGER'],
        ['end_reason', 'TEXT'],
      ]) {
        try {
          await q.run(`ALTER TABLE voice_calls ADD COLUMN ${name} ${ddl}`)
        } catch (e) {
          if (!/duplicate column|already exists/i.test(String(e.message || ''))) throw e
        }
      }
      await q.run(`CREATE TABLE IF NOT EXISTS voice_call_participants (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES voice_calls(call_id) ON DELETE CASCADE
      )`)
      await q.run("CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_active_caller_idx ON voice_calls(caller_id) WHERE state IN ('ringing', 'accepted')")
      await q.run("CREATE UNIQUE INDEX IF NOT EXISTS voice_calls_active_callee_idx ON voice_calls(callee_id) WHERE state IN ('ringing', 'accepted')")
      await q.run('CREATE INDEX IF NOT EXISTS voice_calls_participants_idx ON voice_calls(caller_id, callee_id, state)')
      // Without Redis this process is the only call router; any active row was
      // left by a previous process and cannot still represent a live call.
      if (!redisOn()) {
        await q.run("UPDATE voice_calls SET state = 'ended' WHERE state IN ('ringing', 'accepted')")
        await q.run('DELETE FROM voice_call_participants')
      }
    })()
  }
  return voiceCallSchemaReady
}

async function ensureWsTicketSchema() {
  if (!ticketSchemaReady) {
    ticketSchemaReady = q.run(`CREATE TABLE IF NOT EXISTS ws_auth_tickets (
      ticket_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`)
  }
  return ticketSchemaReady
}

/** Issue a short-lived, single-use credential so the long-lived JWT never enters a URL. */
export async function issueWsTicket(userId, sessionId) {
  await ensureWsTicketSchema()
  const ticket = crypto.randomBytes(32).toString('base64url')
  const ticketHash = crypto.createHash('sha256').update(ticket).digest('hex')
  const now = Date.now()
  await q.run('DELETE FROM ws_auth_tickets WHERE expires_at <= ?', now)
  await q.run('INSERT INTO ws_auth_tickets (ticket_hash, user_id, session_id, expires_at) VALUES (?, ?, ?, ?)', ticketHash, userId, sessionId, now + 60_000)
  return ticket
}

async function consumeWsTicket(ticket) {
  if (!ticket || typeof ticket !== 'string' || ticket.length > 128) return null
  await ensureWsTicketSchema()
  const ticketHash = crypto.createHash('sha256').update(ticket).digest('hex')
  return q.get(
    'DELETE FROM ws_auth_tickets WHERE ticket_hash = ? AND expires_at > ? RETURNING user_id AS userId, session_id AS sessionId',
    ticketHash,
    Date.now()
  )
}

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
  const callTimer = setInterval(() => {
    void expireVoiceCalls().catch((e) => console.warn('[ws] 通话超时清理失败：', e.message))
  }, 5000)
  callTimer.unref()

  wss.on('close', () => {
    clearInterval(timer)
    clearInterval(callTimer)
    offRemote()
  })

  return wss
}

async function acceptSocket(ws, req) {
    const url = new URL(req.url, 'http://localhost')
    const ticket = await consumeWsTicket(url.searchParams.get('ticket') || '')
    const session = ticket
      ? await q.get('SELECT id FROM user_devices WHERE session_id = ? AND user_id = ?', ticket.sessionId, ticket.userId)
      : null
    if (!ticket || !session) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: '连接凭证无效或已过期' } }))
      ws.close(4001, 'unauthorized')
      return
    }
    if (ws.readyState !== 1) return

    const userId = Number(ticket.userId)
    ws.userId = userId
    ws.deviceId = session.id
    ws.isAlive = true

    if (!online.has(userId)) online.set(userId, new Set())
    online.get(userId).add(ws)
    markLocalPresence(userId, true)

    send(ws, 'hello', { userId })
    void announcePresence(userId, true)
    void sendPendingVoiceCalls(ws, userId)

    ws.on('pong', () => (ws.isAlive = true))

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (Buffer.byteLength(raw) > 256 * 1024) return
      // 发消息走 REST，便于落库与返回 id；实时事件只走已认证的 WS。
      if (msg.type === 'typing' && msg.conversationId) {
        /* 成员表是异步查的，所以真正的工作放在一个独立 async 函数里，
           而不是把 `ws.on('message')` 的回调标成 async —— 后者抛出来的错
           会变成一个**没人接的 promise rejection**，在 WS 场景里就是悄无声息。
           `void` 明确表示「不关心它的完成」。 */
        void relayTyping(userId, Number(msg.conversationId))
      } else if (typeof msg.type === 'string' && msg.type.startsWith('call.')) {
        void handleVoiceCallMessage(ws, userId, msg.type, msg.payload || {})
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
          void endVoiceCallsForUser(userId)
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

/* ================= 一对一语音通话信令 ================= */
/* ================= 通话收尾（唯一出口） ================= */

/**
 * 结束一通电话的唯一出口。
 *
 * 为什么必须收敛成一个函数：原来「拒接 / 取消 / 超时 / 挂断 / 断线 / 4 小时到期」
 * 各写了一段 UPDATE，各自清理 participants、各自决定广播什么。加通话记录之后，
 * 任何一条路径漏调就会变成「我明明挂了，聊天里没有这通电话」——
 * 而这种缺失只在特定结束方式下出现，最难被发现。
 *
 * 幂等：UPDATE 带 `state IN ('ringing','accepted')`，重复调用第二次 changes=0 直接返回，
 * 不会落两条记录。
 */
const CALL_RECORD_STATE = { ended: 'ended', rejected: 'declined', cancelled: 'cancelled', expired: 'missed' }

async function finishVoiceCall(callId, { state, reason = null, broadcastType = null, broadcastExtra = {} }) {
  const call = await q.get(
    `SELECT call_id AS callId, conversation_id AS conversationId, caller_id AS callerId, callee_id AS calleeId,
            state, media, started_at AS startedAt
       FROM voice_calls WHERE call_id = ?`,
    callId
  )
  if (!call) return false

  const now = Date.now()
  /* 只有接通过（有 started_at）才有通话时长。振铃时间不算 —— 「打了 12 秒没人接」
     记成 12 秒通话是最容易糊弄、也最没用的一个数字。 */
  const durationSec = call.startedAt ? Math.max(0, Math.round((now - Number(call.startedAt)) / 1000)) : 0

  const updated = await q.run(
    `UPDATE voice_calls
        SET state = ?, ended_at = ?, duration_sec = ?, end_reason = ?
      WHERE call_id = ? AND state IN ('ringing', 'accepted')`,
    state, now, durationSec, reason, callId
  )
  if (!updated.changes) return false

  await q.run('DELETE FROM voice_call_participants WHERE call_id = ?', callId)
  clearTimeout(callExpiryTimers.get(callId))
  callExpiryTimers.delete(callId)
  dismissCallPush([Number(call.calleeId)], callId)

  const recordState = CALL_RECORD_STATE[state] || 'ended'
  let message = null
  try {
    message = await recordCallMessage({
      conversationId: Number(call.conversationId),
      callerId: Number(call.callerId),
      media: call.media || 'audio',
      state: recordState,
      durationSec: recordState === 'ended' ? durationSec : 0,
      endedAt: now,
    })
  } catch (e) {
    /* 记录写失败不能把通话状态卡住：用户挂断这件事已经发生了。 */
    console.warn('[ws] 通话记录写入失败：', e.message)
  }

  const parties = [Number(call.callerId), Number(call.calleeId)]
  if (broadcastType) broadcastToUsers(parties, broadcastType, { callId, ...broadcastExtra })
  if (message) broadcastToUsers(parties, 'message.new', { message })
  return true
}

function dismissCallPush(userIds, callId) {
  for (const userId of new Set(userIds.map(Number))) {
    void sendPushToUser(userId, { type: 'call.dismiss', payload: { callId } }, { ttl: 30 })
      .catch((e) => console.warn('[ws] 来电通知清理失败：', e.message))
  }
}

async function sendPendingVoiceCalls(ws, userId) {
  try {
    await ensureVoiceCallSchema()
    const rows = await q.all(
      `SELECT vc.call_id AS callId, vc.conversation_id AS conversationId, vc.expires_at AS expiresAt, vc.media AS media,
              u.id AS callerId, u.username AS callerUsername, u.nickname AS callerNickname, u.avatar AS callerAvatar
       FROM voice_calls vc JOIN users u ON u.id = vc.caller_id
       WHERE vc.callee_id = ? AND vc.state = 'ringing' AND vc.expires_at > ?`,
      Number(userId), Date.now()
    )
    for (const row of rows) {
      send(ws, 'call.incoming', {
        callId: row.callId,
        conversationId: Number(row.conversationId),
        expiresAt: Number(row.expiresAt),
        media: row.media === 'video' ? 'video' : 'audio',
        caller: { id: Number(row.callerId), username: row.callerUsername, nickname: row.callerNickname, avatar: row.callerAvatar },
      })
    }
  } catch (e) {
    console.warn('[ws] 等待中的来电恢复失败：', e.message)
  }
}

async function expireVoiceCall(callId) {
  try {
    await ensureVoiceCallSchema()
    const call = await q.get(
      "SELECT call_id AS callId FROM voice_calls WHERE call_id = ? AND state = 'ringing' AND expires_at <= ?",
      callId, Date.now()
    )
    clearTimeout(callExpiryTimers.get(callId))
    callExpiryTimers.delete(callId)
    if (!call) return
    await finishVoiceCall(callId, { state: 'expired', reason: 'timeout', broadcastType: 'call.timeout' })
  } catch (e) {
    console.warn('[ws] 通话超时处理失败：', e.message)
  }
}

async function expireVoiceCalls() {
  await ensureVoiceCallSchema()
  const now = Date.now()
  const expired = await q.all(
    "SELECT call_id AS callId, state FROM voice_calls WHERE state IN ('ringing', 'accepted') AND expires_at <= ?",
    now
  )
  for (const call of expired) {
    /* 振铃超时是「没接」；接通过却撞到 4 小时上限，是「正常结束」。 */
    if (call.state === 'ringing') {
      await finishVoiceCall(call.callId, { state: 'expired', reason: 'timeout', broadcastType: 'call.timeout' })
    } else {
      await finishVoiceCall(call.callId, { state: 'ended', reason: 'max_duration', broadcastType: 'call.ended' })
    }
  }
}

async function endVoiceCallsForUser(userId) {
  try {
    if (await isOnlineAnywhere(userId)) return
    await ensureVoiceCallSchema()
    const calls = await q.all(
      "SELECT call_id AS callId, caller_id AS callerId, callee_id AS calleeId, state FROM voice_calls WHERE state IN ('ringing', 'accepted') AND (caller_id = ? OR callee_id = ?)",
      userId, userId
    )
    for (const call of calls) {
      const isCaller = Number(call.callerId) === Number(userId)
      /* 振铃阶段断线要区分是谁断的：
         主叫断线 → 已取消；被叫断线 → 未接。都记成 ended 会出现
         「[语音通话]」这种没有时长、也没说清结果的空记录。 */
      const state = call.state === 'accepted' ? 'ended' : isCaller ? 'cancelled' : 'expired'
      await finishVoiceCall(call.callId, {
        state,
        reason: 'disconnect',
        broadcastType: 'call.ended',
        broadcastExtra: { reason: 'disconnect' },
      })
    }
  } catch (e) {
    console.warn('[ws] 断线通话清理失败：', e.message)
  }
}

async function handleVoiceCallMessage(ws, userId, type, payload) {
  const callId = typeof payload.callId === 'string' ? payload.callId : ''
  try {
    await ensureVoiceCallSchema()

    if (type === 'call.invite') {
      const conversationId = Number(payload.conversationId)
      /* 只认 audio / video。其它值一律当语音 —— 免得一个拼错的 media
         让前端等一路永远不来的视频轨。 */
      const media = payload.media === 'video' ? 'video' : 'audio'
      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(callId) || !Number.isSafeInteger(conversationId) || conversationId <= 0) {
        send(ws, 'call.error', { callId, message: '通话请求无效' })
        return
      }
      await expireVoiceCalls()
      const conversation = await q.get("SELECT type FROM conversations WHERE id = ?", conversationId)
      const members = conversation?.type === 'private' ? await memberIds(conversationId) : []
      if (conversation?.type !== 'private' || members.length !== 2 || !members.includes(Number(userId))) {
        send(ws, 'call.error', { callId, message: '语音通话仅支持会话双方' })
        return
      }
      const calleeId = Number(members.find((id) => Number(id) !== Number(userId)))
      const denied = await privatePairGate(Number(userId), calleeId)
      if (denied) {
        send(ws, 'call.error', { callId, message: denied.error || '当前无法呼叫该用户' })
        return
      }
      const online = await isOnlineAnywhere(calleeId)
      let pushAvailable = false
      try {
        pushAvailable = pushIsConfigured() && await hasPushSubscription(calleeId)
      } catch (e) {
        console.warn('[ws] 来电推送订阅检查失败，仍保留在线呼叫：', e.message)
      }
      if (!online && !pushAvailable) {
        send(ws, 'call.unavailable', { callId, message: '对方当前不在线' })
        return
      }

      const caller = await q.get('SELECT id, username, nickname, avatar FROM users WHERE id = ?', userId)
      const now = Date.now()
      try {
        await tx(async () => {
          await q.run(
            "INSERT INTO voice_calls (call_id, conversation_id, caller_id, callee_id, state, media, created_at, expires_at) VALUES (?, ?, ?, ?, 'ringing', ?, ?, ?)",
            callId, conversationId, Number(userId), calleeId, media, now, now + CALL_RING_TIMEOUT
          )
          await q.run('INSERT INTO voice_call_participants (user_id, call_id) VALUES (?, ?)', Number(userId), callId)
          await q.run('INSERT INTO voice_call_participants (user_id, call_id) VALUES (?, ?)', calleeId, callId)
        })
      } catch (error) {
        if (error.code === '23505' || /SQLITE_CONSTRAINT|unique|duplicate|constraint/i.test(`${error.code || ''} ${error.message || ''}`)) {
          send(ws, 'call.busy', { callId, message: '你或对方正在通话中' })
          return
        }
        throw error
      }

      const incoming = {
        callId,
        conversationId,
        expiresAt: now + CALL_RING_TIMEOUT,
        media,
        caller: caller ? { id: Number(caller.id), username: caller.username, nickname: caller.nickname, avatar: caller.avatar } : { id: Number(userId), nickname: '联系人' },
      }
      broadcastToUsers([calleeId], 'call.incoming', incoming)
      broadcastToUsers([Number(userId)], 'call.ringing', { callId, conversationId })
      if (pushAvailable) {
        /* 来电推送也要按设备判定：被叫人的手机在线（他在看屏幕）→ 不推给手机；
           但他电脑上的那台（人不在电脑前）该响 —— 否则他在电脑上完全不知道有人打来。
           语义与消息推送一致：**逐设备**，在线的不推，离线的照推。 */
        void sendPushToUser(
          calleeId,
          { type: 'call.incoming', payload: incoming },
          { ttl: Math.ceil(CALL_RING_TIMEOUT / 1000), skipDeviceIds: onlineDeviceIds(calleeId) }
        )
          .catch((e) => console.warn('[ws] 来电推送失败：', e.message))
      }
      const timeout = setTimeout(() => void expireVoiceCall(callId), CALL_RING_TIMEOUT + 100)
      timeout.unref()
      callExpiryTimers.set(callId, timeout)
      return
    }

    if (!/^[a-zA-Z0-9_-]{12,80}$/.test(callId)) return
    const call = await q.get(
      'SELECT call_id AS callId, conversation_id AS conversationId, caller_id AS callerId, callee_id AS calleeId, state, media, expires_at AS expiresAt FROM voice_calls WHERE call_id = ?',
      callId
    )
    if (!call || (Number(call.callerId) !== Number(userId) && Number(call.calleeId) !== Number(userId))) {
      send(ws, 'call.error', { callId, message: '通话已结束或无权操作' })
      return
    }
    if (payload.conversationId != null && Number(payload.conversationId) !== Number(call.conversationId)) {
      send(ws, 'call.error', { callId, message: '通话会话校验失败' })
      return
    }

    const isCaller = Number(call.callerId) === Number(userId)
    const peerId = isCaller ? Number(call.calleeId) : Number(call.callerId)
    if (call.state === 'ringing' && Number(call.expiresAt) <= Date.now()) {
      await expireVoiceCall(callId)
      return
    }

    if (type === 'call.accept') {
      if (isCaller || call.state !== 'ringing') return
      /* 接听时刻就是计费/计时的起点。`COALESCE` 保证重复的 accept 不会把起点往后推。 */
      const acceptedAt = Date.now()
      const updated = await q.run(
        "UPDATE voice_calls SET state = 'accepted', started_at = COALESCE(started_at, ?), expires_at = ? WHERE call_id = ? AND state = 'ringing' AND expires_at > ?",
        acceptedAt, acceptedAt + CALL_MAX_DURATION, callId, acceptedAt
      )
      if (!updated.changes) return
      clearTimeout(callExpiryTimers.get(callId))
      callExpiryTimers.delete(callId)
      broadcastToUsers([peerId, Number(userId)], 'call.accepted', {
        callId,
        conversationId: Number(call.conversationId),
        media: call.media === 'video' ? 'video' : 'audio',
      })
      dismissCallPush([Number(call.calleeId)], callId)
      return
    }

    if (type === 'call.reject' || type === 'call.cancel') {
      const allowed = type === 'call.reject' ? !isCaller : isCaller
      if (!allowed || call.state !== 'ringing') return
      const rejected = type === 'call.reject'
      await finishVoiceCall(callId, {
        state: rejected ? 'rejected' : 'cancelled',
        reason: rejected ? 'declined' : 'cancelled',
        broadcastType: rejected ? 'call.rejected' : 'call.cancelled',
        broadcastExtra: { by: Number(userId) },
      })
      return
    }

    if (type === 'call.end') {
      if (call.state !== 'accepted') return
      await finishVoiceCall(callId, { state: 'ended', reason: 'hangup', broadcastType: 'call.ended' })
      return
    }

    const relayTypes = new Set(['call.offer', 'call.answer', 'call.ice'])
    if (!relayTypes.has(type) || call.state !== 'accepted') return
    if (type === 'call.offer' && !isCaller) return
    if (type === 'call.answer' && isCaller) return

    if (type === 'call.offer' || type === 'call.answer') {
      const sdp = payload.description
      if (!sdp || typeof sdp.sdp !== 'string' || sdp.sdp.length > 96_000 || sdp.type !== (type === 'call.offer' ? 'offer' : 'answer')) return
      broadcastToUsers([peerId], type, { callId, conversationId: Number(call.conversationId), description: sdp })
    } else {
      const candidate = payload.candidate
      if (candidate != null && JSON.stringify(candidate).length <= 4096) {
        broadcastToUsers([peerId], type, { callId, conversationId: Number(call.conversationId), candidate })
      }
    }
  } catch (e) {
    console.warn('[ws] 通话信令处理失败：', e.message)
    send(ws, 'call.error', { callId, message: '通话服务暂时不可用' })
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
 * 这个用户**当前在线的设备 id 集合**（本进程内）。
 *
 * ## 用途：多端推送路由
 *
 * 多端场景下，「用户在线」太粗 —— 手机在线就把电脑的通知也吞了。
 * 正确的判定是逐设备：某个推送订阅属于设备 D，D 在线就不推给 D。
 *
 * ## 跨实例的局限
 *
 * 这里只看**本进程**的连接。多实例部署时，用户可能在 A 实例、
 * 设备在 B 实例 —— 那台设备在 A 看来是「离线」，会收到一条推送。
 *
 * 这不会造成「收不到通知」，只会造成「多收一条」——
 * 而多收的那条，内容与实时消息重复，用户看得见但不至于困惑。
 * 反过来如果为了精确而查 Redis，则每条推送都要等一次 Redis 往返，
 * 延迟与可靠性都不划算。**宁可多推一条，不要漏推**。
 *
 * @param {number} userId
 * @returns {Set<number>} 在线设备 id 集合（可能为空）
 */
export function onlineDeviceIds(userId) {
  const id = Number(userId)
  const out = new Set()
  if (!id) return out
  const set = online.get(id)
  if (!set) return out
  for (const ws of set) {
    if (ws.deviceId) out.add(Number(ws.deviceId))
  }
  return out
}

/**
 * 这个用户是否有**任何一台设备**在本进程在线。
 *
 * 与 `onlineDeviceIds` 配套：推送时要同时看「这个用户整体在线吗」
 * （老订阅没有 device_id，只能按整体判）与「这台设备在线吗」。
 *
 * @param {number} userId
 * @returns {boolean}
 */
export function isOnlineHere(userId) {
  return online.has(Number(userId))
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
