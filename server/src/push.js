import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import webpush from 'web-push'
import { q } from './db.js'

let schemaReady

/**
 * 推送订阅表 —— **绑定到设备**。
 *
 * ## 为什么必须绑设备
 *
 * 多端场景下，「用户在线」是个**过于粗的判据**：只要他在手机上看消息，
 * 电脑上的那条通知就不该被推掉（他可能已经离开电脑了）。
 * 正确的语义是：
 *
 * > 对用户的每个订阅（= 一台设备）：**这台设备**当前没有活跃 WS 连接 → 推给它；
 * > 这台设备在线 → 不推给它（它自己会收到 WS 实时消息）。
 *
 * 所以订阅表要记 device_id，推送时逐条比对在线设备集合。
 *
 * ## 迁移方式
 *
 * 老库没有 device_id 列 → 用 `addColumnIfMissing` 补（见 db/sqlite.js 的做法），
 * 补出来的旧记录 device_id 为 NULL：它们属于「设备绑定功能上线前」的订阅，
 * 推送时按「老设备」处理 —— 只要该用户任一设备在线就不推（与旧行为一致）。
 */
async function ensurePushSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await q.run(`CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        p256dh TEXT NOT NULL,
        auth_secret TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`)
      await q.run('CREATE INDEX IF NOT EXISTS web_push_subscriptions_user_idx ON web_push_subscriptions(user_id)')
      /* ⚠️ SQLite 没有 `ADD COLUMN IF NOT EXISTS`，且 PG 与 SQLite 的列定义语法不同 ——
         所以走 db.js 的 addColumnIfMissing（它按驱动分别处理）。
         见 server/src/db/sqlite.js 与 db/postgres.js 里的同名实现。 */
      await addColumnIfMissing('web_push_subscriptions', 'device_id', 'device_id INTEGER')
    })()
  }
  return schemaReady
}

/**
 * 补一个列（不存在才加）。
 *
 * 为什么不直接复用 db.js 导出的那个：db.js 的 addColumnIfMissing 是给
 * 「建表时就要有」的表用的，而推送表是**运行时按需**创建的（ensurePushSchema），
 * 两者要能各自独立工作。这里做一份最小实现，两边逻辑一致。
 *
 * @param {string} table 表名
 * @param {string} column 列名
 * @param {string} definition 列定义（SQLite 与 PG 通用：`<名> <类型>`）
 */
async function addColumnIfMissing(table, column, definition) {
  try {
    const rows = await q.all(`PRAGMA table_info(${table})`)
    /* PG 驱动下 PRAGMA 不存在，会走到 catch → 用另一种方式确认 */
    if (rows && rows.length) {
      if (rows.some((r) => r.name === column)) return
      await q.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      return
    }
  } catch {
    /* PG：走 information_schema */
  }
  try {
    const existing = await q.all(
      `SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ?`,
      table, column
    )
    if (existing && existing.length) return
    await q.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  } catch (error) {
    /* 加不上就算了 —— 推送会退回到「用户级在线判定」，功能不崩 */
    console.warn('[push] 补列失败（推送将按用户级在线判定）：', error.message)
  }
}

/**
 * 确保推送表结构就绪（含 device_id 补列）。
 *
 * 导出给自检脚本用 —— 它需要先建好表再往里写假订阅。
 * 名字带 ForTest 是为了表明「这不是业务路径」，
 * 但它做的事和业务完全一样（同一个 ensurePushSchema），没有第二份实现。
 */
export async function ensurePushSchemaForTest() {
  await ensurePushSchema()
}

function configuredVapid() {
  const publicKey = String(process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim()
  const privateKey = String(process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim()
  const subject = String(process.env.WEB_PUSH_VAPID_SUBJECT || '').trim()
  if (!publicKey || !privateKey || !subject) return null
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    return { publicKey }
  } catch (error) {
    console.warn('[push] VAPID 配置无效：', error.message)
    return null
  }
}

export function pushConfig() {
  const vapid = configuredVapid()
  return vapid ? { enabled: true, publicKey: vapid.publicKey } : { enabled: false, publicKey: null }
}

export function pushIsConfigured() {
  return !!configuredVapid()
}

function isPrivateAddress(address) {
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7))
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')
  }
  return true
}

async function assertSafeEndpoint(value) {
  if (typeof value !== 'string' || value.length < 30 || value.length > 4096) {
    throw Object.assign(new Error('推送地址无效'), { status: 400 })
  }
  let url
  try { url = new URL(value) } catch { throw Object.assign(new Error('推送地址无效'), { status: 400 }) }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      isIP(hostname) || hostname === 'localhost' || /\.(localhost|local|internal|test|invalid|example)$/.test(hostname)) {
    throw Object.assign(new Error('推送地址必须指向公开 HTTPS 推送服务'), { status: 400 })
  }
  let addresses
  try { addresses = await lookup(hostname, { all: true, verbatim: true }) } catch {
    throw Object.assign(new Error('推送服务域名暂时无法解析'), { status: 400 })
  }
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw Object.assign(new Error('推送服务地址不可用'), { status: 400 })
  }
  return value
}

/**
 * 保存推送订阅。
 *
 * @param {number} userId
 * @param {object} raw 浏览器给的订阅对象
 * @param {number|null} deviceId 这台设备的 id（来自 authRequired 的 req.deviceId）
 */
export async function savePushSubscription(userId, raw, deviceId = null) {
  const endpoint = await assertSafeEndpoint(raw?.endpoint)
  const p256dh = String(raw?.keys?.p256dh || '')
  const auth = String(raw?.keys?.auth || '')
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{12,100}$/.test(auth)) {
    throw Object.assign(new Error('推送订阅密钥无效'), { status: 400 })
  }
  await ensurePushSchema()
  const now = Date.now()
  /* device_id 一起 upsert：同一台设备重新订阅时覆盖掉旧记录，
     换设备登录则各存一条 —— 这正是多端推送需要的数据结构。 */
  await q.run(
    `INSERT INTO web_push_subscriptions (endpoint, user_id, p256dh, auth_secret, device_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth_secret = excluded.auth_secret, device_id = excluded.device_id, updated_at = excluded.updated_at`,
    endpoint, Number(userId), p256dh, auth, deviceId ? Number(deviceId) : null, now, now
  )
  return { ok: true }
}

export async function removePushSubscription(userId, endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) return false
  await ensurePushSchema()
  const result = await q.run('DELETE FROM web_push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, Number(userId))
  return Number(result?.changes || 0) > 0
}

export async function hasPushSubscription(userId) {
  if (!pushIsConfigured()) return false
  await ensurePushSchema()
  return !!(await q.get('SELECT 1 FROM web_push_subscriptions WHERE user_id = ? LIMIT 1', Number(userId)))
}

/**
 * 给用户推送，但**逐设备**判定该不该推。
 *
 * ## 语义（多端的核心）
 *
 * 对该用户的每个推送订阅（即一台设备）：
 * - 这台设备**在线**（有活跃 WS 连接）→ 不推给它（它自己会收到 WS 实时消息）；
 * - 这台设备**离线** → 推给它。
 *
 * 旧实现是「任一设备在线就整体不推」——那在单端时代是对的，
 * 多端就成了 bug：你在手机上看消息，电脑上那条通知也被吞了。
 *
 * ## 老订阅（device_id 为 NULL）
 *
 * 设备绑定功能上线前建立的订阅，device_id 是 NULL。
 * 它们无法定位到具体设备 → 保守处理：**该用户任一设备在线就不推**
 * （与旧行为一致，不会造成重复打扰）。
 *
 * @param {number} userId
 * @param {object} payload 推送内容
 * @param {{ ttl?: number, urgency?: string, skipDeviceIds?: Set<number>|number[] }} [options]
 *        skipDeviceIds：额外要跳过的设备（该设备已有活跃连接）
 * @returns {Promise<{ sent: number, configured: boolean, skipped: number }>}
 */
export async function sendPushToUser(userId, payload, { ttl = 90, urgency = 'high', skipDeviceIds = null } = {}) {
  if (!configuredVapid()) return { sent: 0, configured: false, skipped: 0 }
  await ensurePushSchema()
  const rows = await q.all(
    'SELECT endpoint, p256dh, auth_secret AS auth, device_id FROM web_push_subscriptions WHERE user_id = ?',
    Number(userId)
  )
  /* TTL 上限放到 24 小时：来电是 90 秒（错过就没意义），但离线消息要能被
     推送服务保留到用户下次打开手机。超过 24 小时的消息本来也过期了。 */
  const safeTtl = Math.max(1, Math.min(86400, Number(ttl) || 90))
  const safeUrgency = urgency === 'normal' ? 'normal' : 'high'

  /* 在线设备集合：调用方传进来（ws.js 那边有权威数据）。
     没传就退化为「不跳过任何设备」——宁可多推一次，也不要漏推。 */
  const skip = skipDeviceIds
    ? new Set([...skipDeviceIds].map(Number).filter(Boolean))
    : null

  let skipped = 0
  const result = await Promise.all(rows.map(async (row) => {
    /* 设备级判定：这台设备在线就不推 */
    if (row.device_id != null && skip?.has(Number(row.device_id))) {
      skipped += 1
      return false
    }
    try {
      await assertSafeEndpoint(row.endpoint)
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        { TTL: safeTtl, urgency: safeUrgency }
      )
      return true
    } catch (error) {
      /* 404 / 410：订阅已被推送服务注销（用户清了站点数据、换了浏览器）。
         ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY：这条订阅的 p256dh 不是合法公钥，
         说明记录已损坏 —— 它**永远不可能**投递成功，留着只会让每条消息都重试一次。
         两类都属于「永久失效」，直接删；其余（超时、限流、服务端 5xx）保留订阅等下次。 */
      const gone = error.statusCode === 404 || error.statusCode === 410 ||
        error.code === 'ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY'
      if (gone) {
        await removePushSubscription(Number(userId), row.endpoint).catch(() => {})
      } else {
        console.warn('[push] 推送投递失败：', error.statusCode || error.code || 'network error')
      }
      return false
    }
  }))
  return { sent: result.filter(Boolean).length, configured: true, skipped }
}
