import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import webpush from 'web-push'
import { q } from './db.js'

let schemaReady

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
    })()
  }
  return schemaReady
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

export async function savePushSubscription(userId, raw) {
  const endpoint = await assertSafeEndpoint(raw?.endpoint)
  const p256dh = String(raw?.keys?.p256dh || '')
  const auth = String(raw?.keys?.auth || '')
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{12,100}$/.test(auth)) {
    throw Object.assign(new Error('推送订阅密钥无效'), { status: 400 })
  }
  await ensurePushSchema()
  const now = Date.now()
  await q.run(
    `INSERT INTO web_push_subscriptions (endpoint, user_id, p256dh, auth_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth_secret = excluded.auth_secret, updated_at = excluded.updated_at`,
    endpoint, Number(userId), p256dh, auth, now, now
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

export async function sendPushToUser(userId, payload, { ttl = 90, urgency = 'high' } = {}) {
  if (!configuredVapid()) return { sent: 0, configured: false }
  await ensurePushSchema()
  const rows = await q.all(
    'SELECT endpoint, p256dh, auth_secret AS auth FROM web_push_subscriptions WHERE user_id = ?',
    Number(userId)
  )
  /* TTL 上限放到 24 小时：来电是 90 秒（错过就没意义），但离线消息要能被
     推送服务保留到用户下次打开手机。超过 24 小时的消息本来也过期了。 */
  const safeTtl = Math.max(1, Math.min(86400, Number(ttl) || 90))
  const safeUrgency = urgency === 'normal' ? 'normal' : 'high'
  const result = await Promise.all(rows.map(async (row) => {
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
  return { sent: result.filter(Boolean).length, configured: true }
}
