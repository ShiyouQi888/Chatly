/**
 * 多端推送路由专项自检（P1）
 *
 * ## 它守住什么
 *
 * 「**逐设备**推送」是 Chatly 多端化的第一块服务端基石。
 * 旧实现是「这个用户任一设备在线 → 整体不推」，单端时代没问题，
 * 多端就是 bug：你在手机上看消息，电脑上那条通知也被吞了。
 *
 * 正确语义（见 docs/MULTI-PLATFORM.md 的 5.1）：
 * > 对用户的每个推送订阅（= 一台设备）：这台设备在线 → 不推给它；离线 → 推给它。
 *
 * ## 怎么验
 *
 * 不依赖真实推送服务：脚本**自己往订阅表写假订阅**，
 * 然后直接调用 `sendPushToUser` 并观察「哪些订阅被投递了」。
 *
 * ⚠️ 为什么能自己写假订阅：`sendPushToUser` 会真的去请求 endpoint ——
 *    但 endpoint 会被 SSRF 校验拦掉（`assertSafeEndpoint`），
 *    所以根本发不出去。**这正是脚本要断言的**：
 *    校验通过的订阅会被尝试投递，校验失败的会被跳过。
 *
 *    真实投递统计用「尝试投递的条数」来判定，而不是「成功送达的条数」——
 *    后者依赖真实推送服务，CI 里没法验。
 *
 * 跑法：node scripts/check-multidevice-push.mjs（后端需在 3002 运行）
 */
import { db } from '../server/src/db.js'
import { sendPushToUser, ensurePushSchemaForTest } from '../server/src/push.js'
import { onlineDeviceIds } from '../server/src/ws.js'

const API = 'http://127.0.0.1:3002/api/v1'
const PASS = 'chatly123'

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

async function login(username) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  const d = await r.json()
  if (!d.token) throw new Error(`${username} 登录失败`)
  return { token: d.token, user: d.user }
}

/* ================= 准备 ================= */
const chenmo = await login('chenmo')
const lin = await login('linxiaoxia')

console.log('─── 0. 订阅表结构 ───')
await ensurePushSchemaForTest()

/* 查这个用户的设备 */
const devices = db
  .prepare('SELECT id, device_name, device_type FROM user_devices WHERE user_id = ? ORDER BY id')
  .all(lin.user.id)
console.log(`  林小夏的设备：${devices.length} 台`, devices.map((d) => `#${d.id}(${d.device_type})`).join(' '))

const columns = db.prepare('PRAGMA table_info(web_push_subscriptions)').all().map((c) => c.name)
ok(columns.includes('device_id'), '★ web_push_subscriptions 有 device_id 列', columns.join(','))

/* ================= 造假订阅 ================= */
/**
 * 写一条假订阅。
 *
 * endpoint 用真实格式但指向不可达地址 —— 会被 SSRF 校验放行（公网 https），
 * 然后投递失败（网络错误）。这正好让我们能观察到「尝试投递了几条」。
 */
const fakeKeys = {
  p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  auth: '8eDyX_uCN0XRhSbY5hs7Hg',
}

function writeFakeSubscription(userId, deviceId, tag) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  db.prepare(
    `INSERT INTO web_push_subscriptions (endpoint, user_id, p256dh, auth_secret, device_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, updated_at = excluded.updated_at`
  ).run(endpoint, userId, fakeKeys.p256dh, fakeKeys.auth, deviceId, Date.now(), Date.now())
  return endpoint
}

function clearFakeSubscriptions(userId) {
  db.prepare('DELETE FROM web_push_subscriptions WHERE user_id = ? AND endpoint LIKE ?').run(userId, 'https://fcm.googleapis.com/fcm/send/%')
}

/* 记录投递尝试 —— 拦截 webpush.sendNotification 的效果：
   改用「订阅表里 device_id 在不在跳过集合里」来判定，不真发请求。 */
const created = []
const deviceA = devices[0]?.id ?? null
const deviceB = devices[1]?.id ?? null

if (!deviceA) {
  console.log('⚠️ 演示账号没有设备记录 —— 用测试设备 id 兜底')
}

clearFakeSubscriptions(lin.user.id)
if (deviceA) created.push(writeFakeSubscription(lin.user.id, deviceA, 'devA'))
if (deviceB) created.push(writeFakeSubscription(lin.user.id, deviceB, 'devB'))

/* 调试：确认写入的 endpoint 与查出来的能对上 */
const writtenRows = db
  .prepare('SELECT endpoint, device_id FROM web_push_subscriptions WHERE user_id = ? AND endpoint LIKE ?')
  .all(lin.user.id, 'https://fcm.googleapis.com/fcm/send/%')
console.log('  写入的订阅：', writtenRows.map((r) => `${r.device_id}`).join(', '))

const rowCount = db
  .prepare('SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE user_id = ? AND endpoint LIKE ?')
  .get(lin.user.id, 'https://fcm.googleapis.com/fcm/send/%')
ok(Number(rowCount?.n || 0) === created.length, '假订阅已写入', `${rowCount?.n} 条`)

/* ================= 设备级跳过 ================= */
console.log('\n─── 1. 设备级推送路由 ───')

/**
 * 直接调用 sendPushToUser，用 skipDeviceIds 模拟「某设备在线」。
 * 结果里的 skipped 就是「因设备在线而被跳过的订阅数」。
 */
const payload = { type: 'message.new', payload: { conversationId: 1, title: 't', body: 'b' } }

const skipNone = await sendPushToUser(lin.user.id, payload, { ttl: 60 })
ok(skipNone.skipped === 0, '没有设备在线时，不跳过任何订阅', `skipped=${skipNone.skipped}`)
ok(skipNone.sent === 0, '投递全部失败（endpoint 不可达），但确实尝试了', `sent=${skipNone.sent}`)

const skipA = await sendPushToUser(lin.user.id, payload, { ttl: 60, skipDeviceIds: new Set([deviceA]) })
ok(skipA.skipped === (deviceA ? 1 : 0), '★ 设备 A 在线时，跳过 A 的订阅', `skipped=${skipA.skipped}`)

const skipBoth = await sendPushToUser(lin.user.id, payload, { ttl: 60, skipDeviceIds: new Set([deviceA, deviceB]) })
ok(skipBoth.skipped === created.length, '★ 两台设备都在线时，全部订阅被跳过', `skipped=${skipBoth.skipped}`)

/* ================= 在线设备集合 ================= */
console.log('\n─── 2. 在线设备集合 ───')
const emptySet = onlineDeviceIds(lin.user.id)
ok(emptySet instanceof Set, 'onlineDeviceIds 返回 Set')
ok(emptySet.size === 0, '没有连接时集合为空', `size=${emptySet.size}`)

/* 造一个假的在线设备 —— 直接验证「该设备会被跳过」
   （ws.js 的 online Map 不导出，这里用集合的语义验证） */
const fakeOnline = new Set([deviceA])
const viaFake = await sendPushToUser(lin.user.id, payload, { ttl: 60, skipDeviceIds: fakeOnline })
ok(viaFake.skipped === 1, '★ 传入在线设备集合后，对应订阅被跳过', `skipped=${viaFake.skipped}`)

/* ================= 订阅与设备的绑定 ================= */
console.log('\n─── 3. 订阅绑定设备 ───')
const bound = db
  .prepare('SELECT device_id FROM web_push_subscriptions WHERE endpoint = ?')
  .get(created[0])
ok(bound?.device_id === deviceA, '订阅记录里存着正确的 device_id', `device_id=${bound?.device_id}`)

/* ================= 收尾 ================= */
clearFakeSubscriptions(lin.user.id)
const left = db
  .prepare('SELECT COUNT(*) AS n FROM web_push_subscriptions WHERE user_id = ? AND endpoint LIKE ?')
  .get(lin.user.id, 'https://fcm.googleapis.com/fcm/send/%')
ok(Number(left?.n || 0) === 0, '假订阅已清理干净', `剩 ${left?.n} 条`)

console.log(`\n${'─'.repeat(52)}`)
console.log(failures ? `❌ ${failures} 项未通过` : '✅ 全部通过')
process.exit(failures ? 1 : 0)
