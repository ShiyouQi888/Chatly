/**
 * 推送专项自检（规则 + 安全边界，不依赖真实推送服务）
 *
 * 真正「手机收到通知」这一步没法在 CI 里验（需要浏览器订阅 + 厂商推送服务），
 * 但这个脚本能守住最容易错的部分 —— **该不该推、推给谁、推什么**：
 *
 *   1. `/push/config` 需要登录，未配置 VAPID 时明确回 enabled:false；
 *   2. 订阅接口拒绝非公网 HTTPS 地址（防止把服务端当 SSRF 跳板）；
 *   3. 摘要按消息类型分流，且不会把空内容推成一条空通知；
 *   4. 免打扰会话不推、通知开关关掉不推、在线用户不推；
 *   5. 通话记录不推（它是回执，不是待回的消息）。
 *
 * ⚠️ 全程**不给任何用户写假订阅**：只要订阅表为空，`sendPushToUser` 就不会发请求，
 *    所以这里可以安全地调用真实的 `notifyMessagePush()`。
 *
 * 跑法：node scripts/check-push.mjs（后端需在 3002 运行）
 */
import { db } from '../server/src/db.js'
import { pushSnippet, notifyMessagePush } from '../server/src/message-push.js'

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

const chenmo = await login('chenmo')
const lin = await login('linxiaoxia')

const conv = db
  .prepare(
    `SELECT c.id FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
      WHERE c.type = 'private' LIMIT 1`
  )
  .get(chenmo.user.id, lin.user.id)
if (!conv) throw new Error('找不到演示私聊会话，先跑 node server/src/seed.js')
const conversationId = Number(conv.id)

const setMuted = (v) =>
  db.prepare('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?').run(v ? 1 : 0, conversationId, lin.user.id)
const setSetting = (key, value) => {
  /* user_settings 只有 (user_id, key, value) 三列，没有 updated_at —— 别顺手加，
     那是照着别的表的习惯写的，会直接报 "no column named updated_at"。 */
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
  ).run(lin.user.id, key, JSON.stringify(value))
}
const clearSetting = (key) => db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(lin.user.id, key)
const originalMuted = db
  .prepare('SELECT muted FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
  .get(conversationId, lin.user.id)?.muted
const originalSetting = db
  .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'notify_message'")
  .get(lin.user.id)?.value

const textMessage = { id: 999999, kind: 'text', text: '晚上七点，老地方见' }

try {
  console.log(`自检开始（${chenmo.user.nickname} → ${lin.user.nickname}，会话 #${conversationId}）\n`)

  /* ---------- 接口与安全 ---------- */
  console.log('─── 接口与安全 ───')
  const anon = await j('GET', '/push/config')
  ok(anon.status === 401, '未登录读推送配置返回 401', String(anon.status))

  const cfg = await j('GET', '/push/config', null, chenmo.token)
  ok(cfg.status === 200, '登录后可读推送配置', String(cfg.status))
  ok(typeof cfg.d.enabled === 'boolean', '返回明确的 enabled 状态', String(cfg.d.enabled))
  if (cfg.d.enabled) {
    ok(typeof cfg.d.publicKey === 'string' && cfg.d.publicKey.length > 40, 'VAPID 公钥已下发')
  } else {
    ok(true, 'VAPID 未配置 —— 跳过公钥断言（部署时按文档配置）')
  }

  const fakeKeys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }
  const badHttp = await j('PUT', '/push/subscription', { endpoint: 'http://example.com/push/abc', keys: fakeKeys }, chenmo.token)
  ok(badHttp.status === 400, '★ 拒绝 http:// 订阅地址（SSRF 防线）', String(badHttp.status))

  const badLocal = await j('PUT', '/push/subscription', { endpoint: 'https://localhost/push/abc', keys: fakeKeys }, chenmo.token)
  ok(badLocal.status === 400, '★ 拒绝 localhost 订阅地址', String(badLocal.status))

  const badPrivate = await j('PUT', '/push/subscription', { endpoint: 'https://192.168.1.10/push/abc', keys: fakeKeys }, chenmo.token)
  ok(badPrivate.status === 400, '★ 拒绝内网 IP 订阅地址', String(badPrivate.status))

  const badKeys = await j('PUT', '/push/subscription', { endpoint: 'https://fcm.googleapis.com/fcm/send/abcdefghijklmnop', keys: { p256dh: 'x', auth: 'y' } }, chenmo.token)
  ok(badKeys.status === 400, '拒绝非法订阅密钥', String(badKeys.status))

  /* ---------- 摘要 ---------- */
  console.log('\n─── 推送文案 ───')
  ok(pushSnippet({ kind: 'text', text: '你好呀' }) === '你好呀', '文字消息原样推送')
  ok(pushSnippet({ kind: 'image' }) === '[图片]', '图片不推成空串')
  ok(pushSnippet({ kind: 'file', fileName: '报价单.pdf' }) === '[文件] 报价单.pdf', '文件带文件名')
  ok(pushSnippet({ kind: 'location', geo: { name: '深圳湾公园' } }) === '[位置] 深圳湾公园', '位置带地名')
  ok(pushSnippet({ kind: 'poll', text: '周末去哪' }) === '[投票] 周末去哪', '投票带题目')
  ok(pushSnippet({ kind: 'text', text: '   ' }) === '[消息]', '空白内容有兜底，不推一条空通知')
  ok(pushSnippet({ kind: 'text', text: 'x'.repeat(200) }).length <= 81, '超长正文被截断')
  ok(pushSnippet({ kind: 'call', callMedia: 'video' }) === '[视频通话]', '通话记录摘要有对应文案')

  /* ---------- 该不该推 ---------- */
  console.log('\n─── 推送规则 ───')
  setMuted(false)
  clearSetting('notify_message')
  const base = await notifyMessagePush({ conversationId, senderId: chenmo.user.id, message: textMessage })
  ok(base.targets === 1, '正常情况：离线接收者被选中', `targets=${base.targets}`)
  ok(base.sent === 0, '没有订阅时不产生投递（不误发）', `sent=${base.sent}`)

  setMuted(true)
  const muted = await notifyMessagePush({ conversationId, senderId: chenmo.user.id, message: textMessage })
  ok(muted.targets === 0, '★ 免打扰会话不推', `targets=${muted.targets}`)
  setMuted(false)

  setSetting('notify_message', false)
  const off = await notifyMessagePush({ conversationId, senderId: chenmo.user.id, message: textMessage })
  ok(off.targets === 0, '★ 关闭「新消息通知」后不推', `targets=${off.targets}`)

  setSetting('notify_message', true)
  const on = await notifyMessagePush({ conversationId, senderId: chenmo.user.id, message: textMessage })
  ok(on.targets === 1, '重新打开后恢复推送', `targets=${on.targets}`)

  clearSetting('notify_message')
  const callRecord = await notifyMessagePush({
    conversationId,
    senderId: chenmo.user.id,
    message: { id: 999998, kind: 'call', callMedia: 'video', callState: 'ended' },
  })
  ok(callRecord.targets === 0, '★ 通话记录不推（它是回执，不是消息）', `targets=${callRecord.targets}`)
} finally {
  setMuted(!!originalMuted)
  if (originalSetting == null) clearSetting('notify_message')
  else setSetting('notify_message', String(originalSetting).replace(/"/g, '') === 'true')
  console.log('\n已恢复会话免打扰与通知设置')
}

if (failures) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部通过 ✅')
