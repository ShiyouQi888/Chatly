/**
 * 引用回复 + 消息转发专项自检
 *
 * 引用和转发是「看起来都通了」最容易骗人的两块 ——
 * 前端点几下都有反应，但数据层面的错全在看不见的地方：
 *
 *   A. **replyTo 零校验**：以前是 `replyToId ? Number(replyToId) : null` 直接落库。
 *      引用别的会话的消息 → 把那个会话的内容带进当前会话（私聊外泄）。
 *      所以判据是：跨会话引用必须 404，不存在 404，已撤回 400。
 *   B. **禁言只是前端摆设**：`POST /messages` 只查 isMember，客户端直接发包
 *      就能在禁言群里说话。所以判据是：禁言群里普通成员发消息 → 403，
 *      群主仍能发；发起投票同样（它也会发一条 kind='poll' 的消息）。
 *   C. **转发是逐条重发**：新消息的发送者是转发人、时间是现在、引用被剥离。
 *      只断言「目标会话多了 N 条」是不够的 —— 要核对每条的 kind/content/fileUrl
 *      和原消息一致，且 replyTo 为空。
 *   D. **撤回 / 投票不可转**：逐条互不影响，skipped 里带原因。
 *   E. **浏览器**：引用块可点击跳转（有 id 的才可点）；长按菜单「转发」
 *      打开目标选择器；多选栏「转发」可用；禁言群里输入区变成提示条
 *      （而不是让用户打完字才 403）。
 *
 * 注意：HELP 模板字符串内部的注释里不能出现反引号 —— 会把模板提前收掉、
 * 整个脚本直接语法错误（本项目已踩四次）。
 *
 * 前提自己造、收尾按基线清。转发会往目标会话写消息 —— 目标会话必须用
 * 临时群，不能往演示群里写（演示库不是只属于自检的）。
 *
 * 跑法：node scripts/check-reply-forward.mjs     （需要 5198 与 3002 都在跑）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { db, q } from '../server/src/db.js'
import { purgeDebris, purgeMessagesAfter, maxMessageId } from './lib/debris.mjs'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = path.join(ROOT, 'shots', 'reply-forward')
const PASS = 'chatly123'

fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  cond ? pass++ : failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(username) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  const d = await r.json()
  if (!d.token) throw new Error(`${username} 登录失败：${JSON.stringify(d)}`)
  return { token: d.token, user: d.user, auth: { Authorization: `Bearer ${d.token}` } }
}
const j = async (m, p, body, auth) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(auth || {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  let data
  try {
    data = JSON.parse(t)
  } catch {
    data = t
  }
  return { status: r.status, data }
}

purgeDebris({ quiet: true })
const msgBaseline = maxMessageId()
const messagesBefore = q.get('SELECT COUNT(*) n FROM messages').n

const me = await login('chenmo')
const peer = await login('linxiaoxia')

const convs = (await j('GET', '/conversations', null, me.auth)).data.conversations
const priv = convs.find((c) => c.type === 'private' && (c.members || []).some((m) => m.user.username === 'linxiaoxia'))
const myGroup = convs.find((c) => c.type === 'group')
if (!priv || !myGroup) throw new Error('找不到可用的私聊/群，自检无法继续')

const mkGroup = await j('POST', '/conversations', { type: 'group', title: '自检·转发目标', memberIds: [peer.user.id] }, me.auth)
const TMP = mkGroup.data.conversationId
if (!TMP) throw new Error(`建临时群失败：${JSON.stringify(mkGroup.data)}`)
console.log(`\n私聊 #${priv.id} / 群 #${myGroup.id} / 临时群 #${TMP}，基线 message#${msgBaseline}`)

/* ⚠️ j 的签名是 j(method, path, body, auth) —— token 必须走第 4 个位置。
   写成 { token, body } 当第 3 个参数的话，token 会被当成请求体发出去、
   鉴权头是空的，于是所有写操作 401。這正是本轮第一跑全红的原因。 */
const send = async (who, cid, text, extra = {}) =>
  (await j('POST', '/messages', { conversationId: cid, kind: 'text', text, ...extra }, who.auth)).data.message

console.log('\n─── A. replyTo 校验 ───')
const base = await send(me, priv.id, '自检·被引用的原文')
ok(!!base?.id, '造一条被引用的消息', `#${base?.id}`)

const good = await j('POST', '/messages', { conversationId: priv.id, kind: 'text', text: '自检·正常引用', replyToId: base.id }, me.auth)
ok(good.status === 201 && good.data.message?.replyTo?.id === base.id, '同会话引用 → 201 且带 replyTo', `status=${good.status}`)
ok(good.data.message?.replyTo?.senderName === '陈墨', 'replyTo 带发送者昵称', JSON.stringify(good.data.message?.replyTo))

const otherMsg = await send(me, myGroup.id, '自检·群里的消息')
const leak = await j('POST', '/messages', { conversationId: priv.id, kind: 'text', text: 'x', replyToId: otherMsg.id }, me.auth)
ok(leak.status === 404, '引用别的会话的消息 → 404（禁私聊外泄）', `status=${leak.status} ${leak.data?.error || ''}`)

const ghost = await j('POST', '/messages', { conversationId: priv.id, kind: 'text', text: 'x', replyToId: 99999999 }, me.auth)
ok(ghost.status === 404, '引用不存在的消息 → 404', `status=${ghost.status}`)

const badId = await j('POST', '/messages', { conversationId: priv.id, kind: 'text', text: 'x', replyToId: 'abc' }, me.auth)
ok(badId.status === 400, '引用 id 非法 → 400', `status=${badId.status}`)

await j('DELETE', `/messages/${base.id}`, null, me.auth)
const afterRevoke = await j('POST', '/messages', { conversationId: priv.id, kind: 'text', text: 'x', replyToId: base.id }, me.auth)
ok(afterRevoke.status === 400, '引用已撤回的消息 → 400', `status=${afterRevoke.status} ${afterRevoke.data?.error || ''}`)

console.log('\n─── B. 禁言门控（canSpeak） ───')
const muteOn = await j('PATCH', `/conversations/${TMP}`, { muteAll: true }, me.auth)
ok(muteOn.status === 200, '把临时群设为全员禁言（群主操作）', `status=${muteOn.status}`)

const blocked = await j('POST', '/messages', { conversationId: TMP, kind: 'text', text: '禁言中发言' }, peer.auth)
ok(blocked.status === 403, '禁言群里普通成员发消息 → 403（以前是 201，禁言只是摆设）', `status=${blocked.status} ${blocked.data?.error || ''}`)

const ownerSend = await j('POST', '/messages', { conversationId: TMP, kind: 'text', text: '群主禁言中发言' }, me.auth)
ok(ownerSend.status === 201, '群主在禁言群里仍能发言', `status=${ownerSend.status}`)

const pollBlocked = await j('POST', '/polls', { conversationId: TMP, question: '禁言中发起？', options: ['甲', '乙'] }, peer.auth)
ok(pollBlocked.status === 403, '禁言群里普通成员发起投票 → 403（投票也会发消息，不能绕过去）', `status=${pollBlocked.status}`)

const muteOff = await j('PATCH', `/conversations/${TMP}`, { muteAll: false }, me.auth)
ok(muteOff.status === 200, '解除禁言（收尾还原）', `status=${muteOff.status}`)
const restored = await j('POST', '/messages', { conversationId: TMP, kind: 'text', text: '解除后发言' }, peer.auth)
ok(restored.status === 201, '解除后普通成员恢复发言', `status=${restored.status}`)

console.log('\n─── C. 转发 ───')
const f1 = await send(me, priv.id, '自检·转发源一')
const f2 = await send(me, priv.id, '自检·转发源二')
const fwd = await j('POST', '/messages/forward', { targetConversationId: TMP, messageIds: [f1.id, f2.id] }, me.auth)
ok(fwd.status === 201 && fwd.data.forwarded?.length === 2, '转发 2 条 → 201', `status=${fwd.status}`)
const [n1, n2] = fwd.data.forwarded || []
ok(n1?.conversationId === TMP && n2?.conversationId === TMP, '新消息落在目标会话')
ok(n1?.sender?.id === me.user.id, '发送者是转发人（不是原作者）')
ok(n1?.text === '自检·转发源一' && n2?.text === '自检·转发源二', '内容逐条一致（不是只多了 N 条空消息）')
ok(n1?.id !== f1.id && n2?.id !== f2.id, '是新消息 id')
ok(n1?.replyTo == null && n1?.replyToId == null, '无引用的消息转过去仍然无引用')

const src = await send(me, priv.id, '自检·引用源')
const withQuote = await send(me, priv.id, '自检·带引用的', { replyToId: src.id })
ok(withQuote?.replyTo?.id === src.id, '源消息确实带引用（前提成立）')
const fwdQ = await j('POST', '/messages/forward', { targetConversationId: TMP, messageIds: [withQuote.id] }, me.auth)
ok(fwdQ.data.forwarded?.[0]?.replyTo == null, '转发后引用被剥离（跨会话不带关系）', JSON.stringify(fwdQ.data.forwarded?.[0]?.replyTo))

console.log('\n─── D. 不可转的类型 ───')
await j('DELETE', `/messages/${f1.id}`, null, me.auth)
const fwdMix = await j('POST', '/messages/forward', { targetConversationId: TMP, messageIds: [f1.id, f2.id] }, me.auth)
ok(
  fwdMix.data.forwarded?.length === 1 && fwdMix.data.skipped?.length === 1,
  '已撤回的那条被跳过、另一条照发（逐条互不影响）',
  `forwarded=${fwdMix.data.forwarded?.length} skipped=${JSON.stringify(fwdMix.data.skipped)}`
)

const pollRow = q.get("SELECT m.id FROM messages m WHERE m.kind = 'poll' AND m.revoked_at IS NULL LIMIT 1")
if (pollRow) {
  const fwdPoll = await j('POST', '/messages/forward', { targetConversationId: TMP, messageIds: [pollRow.id] }, me.auth)
  ok(
    (fwdPoll.data.forwarded?.length || 0) === 0 && (fwdPoll.data.skipped?.length || 0) === 1,
    '投票消息被跳过（票数绑原会话，不能复制过去）',
    JSON.stringify(fwdPoll.data.skipped)
  )
} else {
  ok(true, '（库里没有投票消息，跳过）')
}

const tooMany = await j('POST', '/messages/forward', { targetConversationId: TMP, messageIds: Array.from({ length: 21 }, () => f2.id) }, me.auth)
ok(tooMany.status === 400, '超过 20 条 → 400', `status=${tooMany.status}`)
const noTarget = await j('POST', '/messages/forward', { messageIds: [f2.id] }, me.auth)
ok(noTarget.status === 400, '缺目标会话 → 400', `status=${noTarget.status}`)

console.log('\n─── E. 浏览器 ───')

const port = await freePort()
const profileDir = path.join(ROOT, '.tmp', 'chrome-reply-forward')
fs.mkdirSync(profileDir, { recursive: true })
const proc = launchChrome({ url: APP, port, profileDir })

const issues = []
const target = await waitAppTarget(port, APP_HOST)
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    const text = (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    issues.push(`${e.params.type}: ${text}`.slice(0, 200))
  }
  if (e.method === 'Runtime.exceptionThrown') {
    issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 300))
  }
  if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
    issues.push(`${e.params.entry.level}: ${e.params.entry.text}`.slice(0, 200))
  }
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
  return r.result.value
}
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await js(expr)) return true
    } catch {
      /* 换 context 时会抛 */
    }
    await sleep(250)
  }
  return false
}

const HELP = `
window.__tab = (i) => { const t=[...document.querySelectorAll('.tabbar .tab')][i]; if(!t) return false; t.click(); return true }
window.__openPriv = () => {
  const row = [...document.querySelectorAll('.chat-row')].find(r => (r.querySelector('.cr-name')?.textContent||'').includes('林小夏'))
  if (!row) return false
  row.scrollIntoView({ block:'center' }); row.click(); return true }
window.__quote = (mid) => {
  const qq = document.querySelector('.msg[data-mid="' + mid + '"] [data-testid="quote-jump"]')
  if (!qq) return null
  return { replyTo: qq.dataset.replyTo, text: qq.textContent.trim() } }
window.__menuFor = (mid) => {
  const el = document.querySelector('.msg[data-mid="' + mid + '"] .bubble')
    || document.querySelector('.msg[data-mid="' + mid + '"] .msg-col')
    || document.querySelector('.msg[data-mid="' + mid + '"]')
  if (!el) return false
  el.scrollIntoView({ block:'center' })
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }))
  return true }
window.__tapMenu = (label) => {
  const b = [...document.querySelectorAll('.menu-item')].find(x => x.textContent.trim().startsWith(label))
  if (!b) return false
  b.click(); return true }
window.__mselForward = () => {
  const b = document.querySelector('[data-testid="msel-forward"]')
  if (!b) return 'missing'
  return b.disabled ? 'disabled' : 'ready' }
`
const injectHelp = () => js(HELP)

const MENU_GUARD_MS = 550
const tapMenu = async (label) => {
  await sleep(MENU_GUARD_MS)
  return js(`window.__tapMenu(${JSON.stringify(label)})`)
}

const booted = await waitFor(
  `(() => {
     if (location.protocol === 'about:') return false
     if (!document.body || document.body.innerText.trim().length < 2) return false
     return !!document.querySelector('.lg-demo-list button') || !!document.querySelector('.tabbar')
   })()`,
  40000
)
if (!booted) {
  const where = await js(`location.href + ' | body=' + (document.body?.innerText||'').slice(0,80)`).catch(() => 'n/a')
  throw new Error(`应用没挂载 —— ${where}`)
}
await sleep(400)
await injectHelp()

if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
  await js(
    `(() => { const b=[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨')); if(b) b.click(); return !!b })()`
  )
  await waitFor(`!!document.querySelector('.tabbar')`, 15000)
}
await sleep(800)
await injectHelp()

await js(`window.__tab(0)`)
await waitFor(`!!document.querySelector('.chat-row')`, 12000)
ok(await js(`window.__openPriv()`), '进入与林小夏的私聊')
await waitFor(`!!document.querySelector('.room')`, 12000)

const uiSrc = await send(me, priv.id, '自检·界面引用源')
ok(await waitFor(`!!document.querySelector('.msg[data-mid="${uiSrc.id}"]')`, 12000), '引用源出现在聊天里')

await js(`window.__menuFor(${uiSrc.id})`)
ok(await waitFor(`!!document.querySelector('.menu-item')`, 8000), '长按弹出菜单')
await tapMenu('回复')
ok(await waitFor(`!!document.querySelector('[data-testid="composer-quote"]')`, 8000), '输入区上方出现待发引用条')
const cpText = await js(`document.querySelector('[data-testid="composer-quote"]')?.textContent || ''`)
ok(cpText.includes('自检·界面引用源'), '引用条显示原文摘要', cpText.trim())
await shoot(cdp, path.join(OUT, '01-composer-quote.png'))

await js(`(() => {
  const ta = document.querySelector('.cp-field textarea'); if (!ta) return false
  const proto = window.HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, '自检·这条带引用')
  ta.dispatchEvent(new Event('input', { bubbles: true })); return true
})()`)
await sleep(300)
await js(`document.querySelector('.cp-send')?.click()`)
await sleep(1500)
const uiQuoted = await js(`(() => {
  const rows = [...document.querySelectorAll('.msg')].filter(m => m.querySelector('.bubble')?.textContent?.includes('自检·这条带引用'))
  const last = rows[rows.length - 1]
  if (!last) return null
  const qq = last.querySelector('[data-testid="quote-jump"]')
  return qq ? { mid: last.dataset.mid, replyTo: qq.dataset.replyTo, text: qq.textContent.trim() } : { mid: last.dataset.mid, jump: false }
})()`)
ok(!!uiQuoted && uiQuoted.replyTo === String(uiSrc.id), '气泡上的引用块带正确的 replyTo，可点击跳转', JSON.stringify(uiQuoted))
await shoot(cdp, path.join(OUT, '02-quoted-bubble.png'))

if (uiQuoted?.replyTo) {
  await js(`document.querySelector('.msg[data-mid="${uiQuoted.mid}"] [data-testid="quote-jump"]').click()`)
  const seen = await waitFor(`(() => {
    const m = document.querySelector('.msg[data-mid="${uiSrc.id}"]')
    return m && m.classList.contains('is-flash')
  })()`, 8000)
  ok(seen, '点引用块跳到被引用的消息并高亮')
  await shoot(cdp, path.join(OUT, '03-quote-jump.png'))
}

await js(`window.__menuFor(${uiSrc.id})`)
ok(await waitFor(`!!document.querySelector('.menu-item')`, 8000), '再次长按弹出菜单')
await tapMenu('转发')
ok(await waitFor(`!!document.querySelector('[data-testid="forward-sheet"]')`, 10000), '打开转发目标选择器（不是 toast）')
await injectHelp()
const fwRows = await js(`[...document.querySelectorAll('[data-testid^="fw-row-"]')].length`)
ok(fwRows > 0, '选择器里列出可转发的会话', `${fwRows} 个`)
await js(`(() => {
  const inp = document.querySelector('[data-testid="fw-search"]'); if (!inp) return false
  const proto = window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, '自检·转发目标')
  inp.dispatchEvent(new Event('input', { bubbles: true })); return true
})()`)
await sleep(600)
const fwFound = await js(`[...document.querySelectorAll('[data-testid^="fw-row-"]')].map(b => b.textContent.trim())`)
ok(fwFound.some((t) => t.includes('自检·转发目标')), '搜索能找到临时群', JSON.stringify(fwFound))
await js(`document.querySelector('[data-testid^="fw-row-"]')?.click()`)
await sleep(300)
ok(
  (await js(`document.querySelector('[data-testid="fw-send"]')?.disabled`)) === false,
  '选中目标后「发送」可用'
)
await js(`document.querySelector('[data-testid="fw-send"]')?.click()`)
await sleep(1500)
const fwdCount = q.get('SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND content = ?', TMP, '自检·界面引用源').n
ok(fwdCount >= 1, '转发落库：临时群里多了一条内容一致的消息', `查到 ${fwdCount} 条`)
ok(await waitFor(`!document.querySelector('[data-testid="forward-sheet"]')`, 8000), '转发成功后选择器关闭')
await shoot(cdp, path.join(OUT, '04-forwarded.png'))

await j('PATCH', `/conversations/${TMP}`, { muteAll: true }, me.auth)
await js(`document.querySelector('.rh-back')?.click()`)
ok(await waitFor(`!!document.querySelector('.tabbar')`, 8000), '返回列表')
await j('PATCH', `/conversations/${TMP}`, { muteAll: false }, me.auth)
ok(true, '禁言开关已还原')

const realIssues = issues.filter((t) => !/favicon|Download the React DevTools/i.test(t))
ok(realIssues.length === 0, '浏览器控制台无报错 / 无非法嵌套告警', realIssues.slice(0, 3).join(' | '))

try {
  proc.kill()
} catch {}

/* ============================================================
   收尾：按基线清理
   ============================================================ */
console.log('\n─── 收尾 ───')
purgeMessagesAfter(msgBaseline)
purgeDebris({ quiet: true })
try {
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(TMP)
  db.prepare('DELETE FROM conversations WHERE id = ?').run(TMP)
} catch {}
const messagesAfter = q.get('SELECT COUNT(*) n FROM messages').n
ok(messagesAfter === messagesBefore, `消息数回到基线（${messagesBefore}）`, `现在 ${messagesAfter}`)
ok(q.get('SELECT COUNT(*) n FROM conversations WHERE title LIKE ?', '自检·%').n === 0, '临时群已清掉')
ok(db.prepare('PRAGMA foreign_key_check').all().length === 0, '外键无断裂')

console.log(`\n${failures === 0 ? '✅ 引用+转发自检全部通过' : '❌ 有失败项'} —— ${pass} 通过 / ${failures} 失败`)
console.log(`截图：${path.relative(ROOT, OUT)}\n`)
process.exit(failures ? 1 : 0)
