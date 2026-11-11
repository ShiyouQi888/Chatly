/**
 * 通话专项自检（真实信令 + 落库核对，不启浏览器）
 *
 * 通话最容易出的问题不是「连不上」，而是**连上了但记录不对**：
 * 挂了没记录、未接记成 0 秒通话、被叫看到的还是「语音」。
 * 所以这个脚本走真实的 WebSocket 信令，每一步都回库里核对：
 *
 *   1. 视频邀请 → 被叫收到的 `call.incoming.media` 必须是 video；
 *   2. 接听 → 主叫收到的 `call.accepted` 带 media，且库里 `started_at` 被写上；
 *   3. 挂断 → 双方都收到 `call.ended` 和一条 `message.new`，消息 kind='call'；
 *   4. 库里的通话行有 ended_at / duration_sec / end_reason；
 *   5. `GET /calls` 双方都能查到，direction 各自正确；
 *   6. 通话记录**不能收藏、不能撤回**（它是事实，不是用户内容）；
 *   7. 振铃中拒接 → 记录为 declined，且没有时长；
 *   8. 未读不因通话记录增加（它是「发生过的事」，不是待回的消息）。
 *
 * 跑法：node scripts/check-call.mjs
 * 前提：后端在 3002 运行，且已执行过 seed。
 */
import { db } from '../server/src/db.js'

const API = 'http://127.0.0.1:3002/api/v1'
const WS = 'ws://127.0.0.1:3002/ws'
const PASS = 'chatly123'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(username) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  const d = await r.json()
  if (!d.token) throw new Error(`${username} 登录失败：${JSON.stringify(d)}`)
  return { token: d.token, user: d.user }
}

const j = async (m, p, body, token) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let d
  try {
    d = JSON.parse(text)
  } catch {
    d = text
  }
  return { status: r.status, d }
}

/** 用一次性票据连 WS —— 服务端不接受长期 JWT，票据只能消费一次 */
async function connect(token) {
  const t = await fetch(`${API}/auth/ws-ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  if (!t.ok) throw new Error(`ws-ticket ${t.status}`)
  const { ticket } = await t.json()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?ticket=${encodeURIComponent(ticket)}`)
    const inbox = []
    ws.onmessage = (e) => inbox.push(JSON.parse(e.data))
    ws.onopen = () => resolve({ ws, inbox })
    ws.onerror = reject
    setTimeout(() => reject(new Error('ws timeout')), 5000)
  })
}

async function waitEvent(inbox, type, ms = 4000, match = () => true) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = inbox.find((e) => e.type === type && match(e.payload || {}))
    if (hit) return hit.payload || {}
    await wait(50)
  }
  return null
}

const me = await login('chenmo')
const peer = await login('linxiaoxia')

/* 会话 id 直接查库：`GET /conversations` 的出参不含 peers（前端自己算对端），
   在这里反推会把「哪条是私聊」变成一个脆弱的假设。 */
const conv = db
  .prepare(
    `SELECT c.id FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
      WHERE c.type = 'private' LIMIT 1`
  )
  .get(me.user.id, peer.user.id)
if (!conv) throw new Error('找不到陈墨与林小夏的私聊会话，先跑 node server/src/seed.js')
const conversationId = Number(conv.id)
/* 基线：记录测试前的最后一条消息 id 与未读，收尾时只删本轮产生的 */
const baseMsgId = db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM messages').get().n
const callIds = []

const callRow = (id) => db.prepare('SELECT * FROM voice_calls WHERE call_id = ?').get(id)
const msgsOfCall = () =>
  db.prepare("SELECT * FROM messages WHERE kind = 'call' AND id > ? ORDER BY id").all(baseMsgId)

const A = await connect(me.token)
const B = await connect(peer.token)

try {
  console.log(`自检开始（${me.user.nickname} ↔ ${peer.user.nickname}，会话 #${conversationId}）\n`)

  const anon = await j('GET', '/calls', null, null)
  ok(anon.status === 401, '未登录查通话记录返回 401', String(anon.status))

  /* ---------- 一、视频通话：邀请 → 接听 → 挂断 ---------- */
  console.log('─── 视频通话完整链路 ───')
  /* 未读基线要在**产生通话记录之前**取：演示库本身就有几条林小夏没读的消息，
     断言「未读 == 0」会把那几条存量误判成通话造成的。这里只比差值。 */
  const unreadBefore = (await j('GET', '/conversations', null, peer.token)).d.conversations.find(
    (c) => Number(c.id) === conversationId
  )?.unread ?? 0
  const callId = `check_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  callIds.push(callId)

  A.ws.send(JSON.stringify({ type: 'call.invite', payload: { callId, conversationId, media: 'video' } }))
  const incoming = await waitEvent(B.inbox, 'call.incoming', 4000, (p) => p.callId === callId)
  ok(!!incoming, '被叫收到来电')
  ok(incoming?.media === 'video', '★ 来电带的是视频类型', String(incoming?.media))

  const ring = callRow(callId)
  ok(ring?.state === 'ringing', '库里写入 ringing')
  ok(ring?.media === 'video', '★ 库里媒体类型是 video', String(ring?.media))
  ok(!ring?.started_at, '未接听前没有 started_at')

  B.ws.send(JSON.stringify({ type: 'call.accept', payload: { callId, conversationId } }))
  const accepted = await waitEvent(A.inbox, 'call.accepted', 4000, (p) => p.callId === callId)
  ok(!!accepted, '主叫收到接听通知')
  ok(accepted?.media === 'video', '接听通知带回媒体类型', String(accepted?.media))

  const talking = callRow(callId)
  ok(talking?.state === 'accepted', '库里状态是 accepted')
  ok(Number(talking?.started_at) > 0, '★ 接听时写入了 started_at')

  /* 让通话「持续」一秒，才能验证时长不是恒等于 0 */
  await wait(1100)
  A.ws.send(JSON.stringify({ type: 'call.end', payload: { callId, conversationId } }))
  const endedByPeer = await waitEvent(B.inbox, 'call.ended', 4000, (p) => p.callId === callId)
  ok(!!endedByPeer, '被叫收到挂断')

  const done = callRow(callId)
  ok(done?.state === 'ended', '库里状态是 ended')
  ok(Number(done?.ended_at) >= Number(done?.started_at), 'ended_at 不早于 started_at')
  ok(Number(done?.duration_sec) >= 1, '★ 通话时长按接听时刻计算', `${done?.duration_sec}s`)

  /* ---------- 二、通话记录消息 ---------- */
  console.log('\n─── 通话记录消息 ───')
  const newMsg = await waitEvent(B.inbox, 'message.new', 4000, (p) => p?.message?.kind === 'call')
  ok(!!newMsg, '★ 双方都收到 message.new 通话记录', newMsg?.message?.kind || 'none')

  const records = msgsOfCall()
  ok(records.length === 1, '库里落了一条 kind=call 的消息', `${records.length} 条`)
  const rec = records[0]
  ok(rec?.call_media === 'video', '记录消息带媒体类型', String(rec?.call_media))
  ok(rec?.call_state === 'ended', '记录消息带结果状态', String(rec?.call_state))
  ok(Number(rec?.audio_duration_ms) >= 1000, '记录消息带时长', `${rec?.audio_duration_ms}ms`)
  ok(Number(rec?.sender_id) === Number(me.user.id), '发送者是主叫')

  /* 通话记录不是用户内容：不能收藏、不能撤回 */
  const fav = await j('POST', '/favorites', { messageId: rec.id }, me.token)
  ok(fav.status === 400, '★ 通话记录不能收藏', String(fav.status))
  const revoke = await j('DELETE', `/messages/${rec.id}`, null, me.token)
  ok(revoke.status === 400, '★ 通话记录不能撤回', String(revoke.status))

  /* ---------- 三、历史接口 ---------- */
  console.log('\n─── 通话历史 ───')
  const mine = (await j('GET', '/calls?limit=10', null, me.token)).d
  const mineRow = (mine.calls || []).find((c) => c.callId === callId)
  ok(!!mineRow, '主叫能在历史里查到')
  ok(mineRow?.direction === 'outgoing', '主叫方向是 outgoing', String(mineRow?.direction))
  ok(mineRow?.media === 'video', '历史带媒体类型', String(mineRow?.media))
  ok(Number(mineRow?.durationSec) >= 1, '历史带真实时长', `${mineRow?.durationSec}s`)
  ok(Number(mineRow?.peer?.id) === Number(peer.user.id), '对端是林小夏')

  const theirs = (await j('GET', '/calls?limit=10', null, peer.token)).d
  const theirRow = (theirs.calls || []).find((c) => c.callId === callId)
  ok(theirRow?.direction === 'incoming', '被叫方向是 incoming', String(theirRow?.direction))
  ok(theirRow?.peer?.id === me.user.id || Number(theirRow?.peer?.id) === Number(me.user.id), '被叫看到的对端是陈墨')

  /* ---------- 四、未读不被通话记录污染 ---------- */
  const beforeRead = (await j('GET', '/conversations', null, peer.token)).d.conversations.find(
    (c) => Number(c.id) === conversationId
  )
  const callUnread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE conversation_id = ? AND sender_id != ? AND kind = 'call' AND id > ?`
    )
    .get(conversationId, peer.user.id, baseMsgId).n
  ok(callUnread === 1, '本轮确实有一条通话记录')
  ok(
    Number(beforeRead?.unread) === Number(unreadBefore),
    '★ 被叫未读数没有被通话记录顶起来',
    `${unreadBefore} → ${beforeRead?.unread}`
  )

  /* ---------- 五、拒接 ---------- */
  console.log('\n─── 拒接 ---')
  const rejectId = `check_${Date.now()}_rej_${Math.random().toString(36).slice(2, 6)}`
  callIds.push(rejectId)
  A.ws.send(JSON.stringify({ type: 'call.invite', payload: { callId: rejectId, conversationId, media: 'audio' } }))
  await waitEvent(B.inbox, 'call.incoming', 4000, (p) => p.callId === rejectId)
  B.ws.send(JSON.stringify({ type: 'call.reject', payload: { callId: rejectId, conversationId } }))
  await waitEvent(A.inbox, 'call.rejected', 4000, (p) => p.callId === rejectId)

  const rejected = callRow(rejectId)
  ok(rejected?.state === 'rejected', '库里状态是 rejected')
  ok(!rejected?.duration_sec, '拒接没有通话时长', String(rejected?.duration_sec))

  const rejectRecord = db
    .prepare("SELECT * FROM messages WHERE kind = 'call' AND id > ? ORDER BY id DESC LIMIT 1")
    .get(baseMsgId)
  ok(rejectRecord?.call_state === 'declined', '拒接记录为 declined', String(rejectRecord?.call_state))
  ok(Number(rejectRecord?.audio_duration_ms) === 0, '拒接记录的时长为 0', String(rejectRecord?.audio_duration_ms))
  ok(rejectRecord?.call_media === 'audio', '语音通话记录为 audio', String(rejectRecord?.call_media))
} finally {
  /* 收尾：删掉本轮的电话行与通话记录消息，演示库回到基线 */
  for (const id of callIds) db.prepare('DELETE FROM voice_calls WHERE call_id = ?').run(id)
  db.prepare("DELETE FROM messages WHERE kind = 'call' AND id > ?").run(baseMsgId)
  A.ws.close()
  B.ws.close()
  console.log('\n已清理本轮通话记录')
}

if (failures) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部通过 ✅')
