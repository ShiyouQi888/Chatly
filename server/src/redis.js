/**
 * Redis —— 跨实例的「在线状态」(presence) + 事件广播 (pub/sub)
 *
 * ## 为什么它是**可选**的
 * 单进程开发（本机跑 22 支自检、`npm run dev`）时，没有 Redis 也必须**完全正常** ——
 * 一个「先起个容器才能聊天」的服务，本地根本跑不起来。
 * 所以本模块的第一原则是：
 *
 *   - `REDIS_URL` 为空 → 整个模块是 no-op，presence 退回进程内 Map，广播只在本进程内。
 *   - 连不上 / 连上又掉线 → **降级**，不是崩溃。日志只说一次，不刷屏。
 *
 * `ws.js` 里那个本地 Map 始终是「快路径」，Redis 只负责它做不到的两件事：
 *   ① 多实例时回答「A 实例上那个我在线吗」；
 *   ② 把事件送到挂在别的实例上的连接。
 *
 * ## presence 为什么用「按用户的 ZSET」而不是 `SET k 1 EX 45`
 * 一个用户可能同时连着实例 A 和实例 B。如果 A 断开时直接 `DEL`，
 * B 上那个还活着的连接就被**误判下线**了。
 * 改成 ZSET：member = 实例 id，score = 该实例的过期时刻。
 *   - 每个实例只刷自己那条 score（`ZADD`），互不干扰；
 *   - 判在线 = 有没有 `score > now` 的成员；
 *   - 断开时只 `ZREM` 自己那条（`markLocalPresence(id, false)`）；
 *   - 死掉的实例留下的陈旧成员，在**读取时**顺带 `ZREMRANGEBYSCORE` 清掉，
 *     不需要额外的定时清理器。
 *
 * ⚠️ 心跳定时器 `unref()` 掉了：自检脚本 import 本模块后必须能自然退出，
 *    一个不 unref 的 interval 会把进程永久吊住。
 */
import './env.js'

const URL_ = String(process.env.REDIS_URL || '').trim()
/** presence 的存活窗口（秒）。掉线时靠它兜底 —— 进程被 kill -9 是收不到 close 的。 */
const TTL_SEC = Math.max(10, Number(process.env.PRESENCE_TTL) || 45)
/** 心跳间隔取 1/3 TTL：连丢两次心跳才会被判过期，不会因为一次抖动就闪断。 */
const HEARTBEAT_MS = Math.max(3000, Math.round((TTL_SEC * 1000) / 3))
const CHANNEL = 'chatly:events'

/** 本实例的标识：写进 ZSET 的 member，也是广播去重的依据 */
const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`

/** off（未配置）/ on（可用）/ degraded（连过但坏了，按 off 处理） */
let state = URL_ ? 'init' : 'off'
let pub = null
let sub = null
let readyPromise = null
let heartbeat = null

/** 本实例上「有活跃连接」的用户 —— 心跳只需要刷这些人 */
const localPresent = new Set()
/** 远端事件的订阅者（ws.js 注册一个） */
const handlers = new Set()

/* ================= 对外：状态 ================= */

/** 把 URL 里的密码抹掉再往外报 —— 日志和 /health 都不该出现凭据 */
function maskUrl(u) {
  try {
    const parsed = new URL(u)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '(unparsable)'
  }
}

export function status() {
  return { state, configured: !!URL_, url: URL_ ? maskUrl(URL_) : null, ttlSec: TTL_SEC, instanceId }
}

export function isEnabled() {
  return state === 'on'
}

/* ================= 对外：连接 ================= */

function degrade(e) {
  if (state === 'degraded') return
  state = 'degraded'
  console.warn(
    `[redis] 不可用，已降级为「单进程内存」模式（presence 只看本进程、事件不跨实例）：${e?.message || e}`
  )
}

/**
 * 连上 Redis（幂等）。**不会被 reject** —— 连不上就返回 false 并降级，
 * 这样调用方（index.js / ws.js）可以直接 `await ready()` 而不用套 try/catch。
 */
export async function ready() {
  if (!URL_) return false
  if (state === 'on') return true
  if (!readyPromise) readyPromise = connect()
  return readyPromise
}

async function connect() {
  let createClient
  try {
    ;({ createClient } = await import('redis'))
  } catch (e) {
    degrade(new Error(`redis 包加载失败：${e.message}`))
    return false
  }

  const opts = {
    url: URL_,
    /* 重连不要无限重试：本地开发时 Redis 经常是「没起过」，
       无限重试会一直刷错误日志，也会让进程迟迟不退。5 次之后放弃、走降级。 */
    socket: { reconnectStrategy: (retries) => (retries > 5 ? false : Math.min(retries * 300, 2000)) },
  }

  pub = createClient(opts)
  sub = pub.duplicate()
  pub.on('error', degrade)
  sub.on('error', degrade)

  try {
    await pub.connect()
    await sub.connect()
    /* ⚠️⚠️ `subscribe` **必须**传 listener。
       node-redis v6（@redis/client）不再发通用的 `'message'` 事件，
       而是按频道存一个 listener 回调。不传 listener 时 `subscribe()` 本身**不报错**，
       要等**第一条消息到达**才在内部抛 `listener is not a function` ——
       症状是「连接成功、publish 返回成功、对面就是收不到」，极难定位。
       listener 的签名是 `(message, channel)`（**不是** `(channel, message)`，写反了两边都拿到错值）。 */
    await sub.subscribe(CHANNEL, (message, channel) => {
      if (channel !== CHANNEL) return
      deliver(message)
    })
  } catch (e) {
    degrade(e)
    await closeClients()
    return false
  }

  state = 'on'
  heartbeat = setInterval(flushHeartbeat, HEARTBEAT_MS)
  heartbeat.unref?.()
  console.log(`[redis] 已连接 ${maskUrl(URL_)}（presence TTL ${TTL_SEC}s，实例 ${instanceId}）`)
  return true
}

async function closeClients() {
  for (const c of [pub, sub]) {
    try {
      if (c?.isOpen) await c.quit()
    } catch {}
  }
  pub = sub = null
}

export async function close() {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  localPresent.clear()
  await closeClients()
  if (state === 'on') state = URL_ ? 'init' : 'off'
}

/* ================= 对外：presence ================= */

const pKey = (userId) => `chatly:presence:${Number(userId)}`

/**
 * 声明「这个用户在本实例上有连接 / 没有了」。
 * 同步返回：本实例的 Map 是权威快路径，Redis 只是异步补一刀（失败也不影响本地判断）。
 */
export function markLocalPresence(userId, on) {
  const id = Number(userId)
  if (!id) return
  if (on) localPresent.add(id)
  else localPresent.delete(id)
  if (!isEnabled()) return
  void (on ? touch([id]) : release([id]))
}

function flushHeartbeat() {
  if (!isEnabled() || !localPresent.size) return
  void touch([...localPresent])
}

/** 续期：加分 + 顺手清掉过期的成员 */
async function touch(ids) {
  if (!isEnabled() || !ids.length) return
  try {
    const now = Date.now()
    const m = pub.multi()
    for (const id of ids) {
      const k = pKey(id)
      m.zAdd(k, [{ score: now + TTL_SEC * 1000, value: instanceId }])
      m.zRemRangeByScore(k, '-inf', now)
      // 键本身的 TTL 比成员窗口长一倍：两者都过期时键直接消失，不留垃圾
      m.expire(k, TTL_SEC * 2)
    }
    await m.exec()
  } catch (e) {
    degrade(e)
  }
}

/** 断开：只摘掉**自己**那一条，别的实例上的连接不受影响 */
async function release(ids) {
  if (!isEnabled() || !ids.length) return
  try {
    const m = pub.multi()
    for (const id of ids) m.zRem(pKey(id), instanceId)
    await m.exec()
  } catch (e) {
    degrade(e)
  }
}

/**
 * 批量问「这些人里哪些在**任意**实例上在线」（含本实例 —— 本实例的连接也会写 Redis，
 * 所以这里不需要额外并上本地 Map，调用方直接用它就行）。
 * 返回 Set<number>。Redis 不可用时返回空 Set：调用方自己并上本地 Map。
 */
export async function remotePresent(userIds) {
  const ids = [...new Set((userIds || []).map(Number))].filter(Boolean)
  if (!ids.length) return new Set()
  if (!isEnabled()) return new Set()
  try {
    const now = Date.now()
    const m = pub.multi()
    for (const id of ids) m.zCount(pKey(id), `(${now}`, '+inf')
    const res = await m.exec()
    const out = new Set()
    res.forEach((n, i) => {
      if (Number(n) > 0) out.add(ids[i])
    })
    return out
  } catch (e) {
    degrade(e)
    return new Set()
  }
}

/* ================= 对外：广播 ================= */

/**
 * 把一条事件发给别的实例。
 * `origin` = 自己，订阅端会跳过它 —— 本地投递由调用方（ws.js）**立即**完成，
 * 不等 Redis 回环，避免多一跳延迟；`origin` 判断保证不会重复投一次。
 */
export function publishTo(targets, type, payload) {
  if (!isEnabled()) return
  const ids = [...new Set((targets || []).map(Number))].filter(Boolean)
  if (!ids.length) return
  try {
    const body = JSON.stringify({ origin: instanceId, targets: ids, type, payload })
    // 不 await：发消息接口不该被 Redis 的往返拖住
    pub.publish(CHANNEL, body).catch(degrade)
  } catch (e) {
    degrade(e)
  }
}

/** 注册远端事件处理（ws.js 用），返回取消注册的函数 */
export function onRemoteEvent(handler) {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

function deliver(raw) {
  let ev
  try {
    ev = JSON.parse(raw)
  } catch {
    return
  }
  if (!ev || ev.origin === instanceId) return // 自己发的，本地已投过
  if (!Array.isArray(ev.targets) || !ev.type) return
  for (const h of handlers) {
    try {
      h(ev)
    } catch (e) {
      console.warn('[redis] 远端事件处理失败（已忽略）：', e.message)
    }
  }
}
