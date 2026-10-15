/**
 * 长按手势专项自检（真实触摸事件）
 *
 * 跑法：node scripts/check-longpress.mjs     （需要 5198 与 3002 都在跑）
 *
 * 长按手势验证（真实触摸事件）
 *
 * ## 为什么必须用 Input.dispatchTouchEvent
 *
 * 本次要修的缺陷就是「手机上长按不能用，只有桌面右键」。
 * 所以用 `MouseEvent('contextmenu')` 来验是**自欺欺人** ——
 * 那恰好是桌面路径。只有真实的触摸序列才能证明真机可用。
 *
 * ## 判据的关键：在**按住期间**查菜单
 *
 * 长按的时序是：touchStart → 计时器到点（480ms）→ 弹菜单 → 用户松手
 * → 浏览器为这次手势**补发一个 click**。
 * 所以「抬手之后」再查 DOM，看到的是被那次 click 关掉的菜单 ——
 * 会误判成「长按没生效」。探针第一版就是这么错的。
 */
import fs from 'node:fs'
/* ⚠️ qSync 是 SQLite 专有的**同步**直连，只给自检脚本用（q 已 async）。 */
import { db, qSync as q } from '../server/src/db.js'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/longpress'
fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
const ok = (c, l, e = '') => (c ? (pass++, console.log(`  ✅ ${l}`)) : (fail++, console.log(`  ❌ ${l}${e ? ' — ' + e : ''}`)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const req = async (p, { method = 'GET', token, body } = {}) => {
  const r = await fetch(API + p, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  let d
  try { d = JSON.parse(t) } catch { d = t }
  return { status: r.status, data: d }
}
const login = async (u) => (await req('/auth/login', { method: 'POST', body: { username: u, password: 'chatly123' } })).data

const msgBaseline = q.get('SELECT COALESCE(MAX(id),0) v FROM messages').v
const me = await login('chenmo')
const peer = await login('linxiaoxia')
const convs = (await req('/conversations', { token: me.token })).data.conversations
const priv = convs.find((c) => c.type === 'private' && (c.members || []).some((m) => m.user.username === 'linxiaoxia'))
const send = async (token, conversationId, text) =>
  (await req('/messages', { method: 'POST', token, body: { conversationId, kind: 'text', text } })).data.message

const t1 = await send(peer.token, priv.id, '探针·长按目标')
const t2 = await send(peer.token, priv.id, '探针·短按目标')
console.log(`\n私聊 #${priv.id}，探针 #${t1.id}（长按）/ #${t2.id}（短按）\n`)

const port = await freePort()
const profileDir = 'D:/BS-chat-os/.tmp/chrome-longpress'
/* ⚠️ 清不掉临时 profile **不能**让整个自检崩掉。
   本机（Windows + 沙箱）对 `.tmp/` 的删除会被 safe-delete 拦下并抛
   「Some operations were aborted」，结果这支自检在**启动时**就退出、
   一条断言都跑不到 —— 报出来的现象是「长按自检挂了」，
   而真实原因只是临时目录没删干净。
   一个 Chrome profile 目录本来就是个可以覆盖的缓存：删不掉就复用。 */
try {
  fs.rmSync(profileDir, { recursive: true, force: true })
} catch (e) {
  console.log(`（临时 profile 未能清空，继续复用：${String(e.message).slice(0, 80)}）`)
}
fs.mkdirSync(profileDir, { recursive: true })
const proc = launchChrome({ url: APP, port, profileDir })

const issues = []
const target = await waitAppTarget(port, APP_HOST)
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Runtime.exceptionThrown') issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 300))
  if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') issues.push('error: ' + e.params.entry.text.slice(0, 200))
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
/* ★ 不打开触摸模拟，Input.dispatchTouchEvent 无效 —— 「长按」这条路径压根试不到 */
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
  return r.result.value
}
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await js(expr)) return true } catch {}
    await sleep(200)
  }
  return false
}

/** 取一个「视口内」的目标点。房间会自动贴底，坐标必须现取现用。 */
const boxOf = async (selector) => js(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  if (r.top < 0 || r.bottom > window.innerHeight || r.height <= 0) return { offscreen: true, top: Math.round(r.top) }
  return { x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + Math.min(14, r.height / 2)) }
})()`)

/**
 * 按住 holdMs，**在按住状态下**把菜单项文本一起取回来，然后抬手。
 *
 * ⚠️ 菜单项必须在**按住期间**读。`holdAndProbe` 一旦返回就已经抬手了，
 * 那时菜单会被补发的 click 关掉（或已被我们的 guard 放行关闭），
 * 再调 `document.querySelectorAll('.menu-item')` 只能拿到空数组 ——
 * 于是「长按弹菜单」明明通过了，紧跟的「菜单里有 X」却全红。
 * 这个探针为此返工了两次。
 */
const holdAndProbe = async (selector, holdMs, { moveBy = 0 } = {}) => {
  const box = await boxOf(selector)
  if (!box || box.offscreen) return { ok: false, why: box?.offscreen ? `屏外 top=${box.top}` : '找不到元素' }
  const pt = (x, y) => [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(box.x, box.y) })
  const steps = moveBy ? 6 : 1
  for (let i = 1; i <= steps; i++) {
    await sleep(holdMs / steps)
    if (moveBy) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(box.x, box.y + (moveBy * i) / steps) })
  }
  /* ★ 按住状态下一次性取回：数量 + 文本 + 是否开着 300ms 防误触窗 */
  const snap = await js(`(() => {
    const items = [...document.querySelectorAll('.menu-item')].map(b => b.textContent.trim())
    return { count: items.length, items }
  })()`)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  return { ok: true, menuWhileHeld: snap.count, items: snap.items }
}

const closeMenus = async () => {
  await js(`document.querySelector('.sheet-mask')?.click()`)
  await sleep(400)
  /* 兜底：某些情况下点遮罩会被 guard 挡住（刚打开 300ms 内），等一会儿再点 */
  if (await js(`!!document.querySelector('.menu-item')`)) {
    await sleep(400)
    await js(`document.querySelector('.sheet-mask')?.click()`)
    await sleep(300)
  }
}

const booted = await waitFor(
  `location.protocol !== 'about:' && document.body.innerText.trim().length > 2 &&
   (!!document.querySelector('.lg-demo-list button') || !!document.querySelector('.tabbar'))`,
  40000
)
if (!booted) throw new Error('应用没挂载')
if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
  await js(`[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨'))?.click()`)
  await waitFor(`!!document.querySelector('.tabbar')`, 15000)
}
await sleep(800)
await js(`[...document.querySelectorAll('.tabbar .tab')][0]?.click()`)
await waitFor(`!!document.querySelector('.chat-row')`, 12000)
await js(`(() => { const r=[...document.querySelectorAll('.chat-row')].find(x=>(x.querySelector('.cr-name')?.textContent||'').includes('林小夏')); if(!r) return false; r.scrollIntoView({block:'center'}); r.click(); return true })()`)
await waitFor(`!!document.querySelector('.room')`, 12000)
await sleep(700)

console.log('─── ① 长按（真实触摸）弹菜单 ───')
await waitFor(`!!document.querySelector('.msg[data-mid="${t1.id}"]')`, 12000)
const r1 = await holdAndProbe(`.msg[data-mid="${t1.id}"] .bubble`, 900)
ok(r1.ok && r1.menuWhileHeld > 0, '★ 按住 900ms → 菜单出现（按住期间实测）', JSON.stringify(r1))
if (r1.ok && r1.menuWhileHeld > 0) {
  /* 用按住期间取回的那份，别再查一次 —— 那时已经抬手了 */
  const items = r1.items
  ok(
    items.includes('回复') && items.includes('复制') && items.includes('收藏'),
    '菜单里有回复 / 复制 / 收藏',
    JSON.stringify(items)
  )
  await shoot(cdp, `${OUT}/01-touch-longpress.png`)
}

console.log('\n─── ② 松开手指后菜单**仍然**在（补发的 click 不能关掉它） ───')
/* 这条是本轮真正的 bug：长按弹出来了，但松手时浏览器补发的 click
   落在遮罩上，菜单瞬间被自己关掉 —— 用户看到的是「长按没反应」。 */
const stillOpen = await js(`document.querySelectorAll('.menu-item').length`)
ok(stillOpen > 0, '★ 抬手之后菜单依然是开的（补发的 click 被防住了）', `menu-item=${stillOpen}`)
await closeMenus()
ok((await js(`document.querySelectorAll('.menu-item').length`)) === 0, '点遮罩能正常关掉菜单（防误触没有把关闭也一起挡掉）')

console.log('\n─── ③ 长按不能连带触发 click（不该变成「引用回复」） ───')
/* 判据是输入区上方那条引用提示（[data-testid="composer-quote"]）。
   长按之后它**必须没出现** —— 出现了就说明长按尾巴上的 click
   被当成了正常点击、顺手触发了「引用回复」。 */
const qBefore = await js(`!!document.querySelector('[data-testid="composer-quote"]')`)
await holdAndProbe(`.msg[data-mid="${t1.id}"] .bubble`, 900)
await sleep(500)
const qAfter = await js(`!!document.querySelector('[data-testid="composer-quote"]')`)
ok(qBefore === false && qAfter === false, '★ 长按之后没有出现引用条（click 被吞掉）', `前 ${qBefore} / 后 ${qAfter}`)
await closeMenus()

console.log('\n─── ④ 短按文字气泡什么都不发生（不挂引用、不弹菜单） ───')
await closeMenus()
/* ⚠️ 这条是配合引用链修掉的旧行为改的口径。
   以前 `.bubble` 上挂了 onClick={() => onReply(m)} —— 点一下文字就挂上引用，
   真机上想复制/选中文字时一点就进引用态，只能去输入区按 ✕，这是误触。
   现在引用只从长按菜单的「回复」进，短按气泡 = 无操作。
   判据也要跟着换：短按之后引用条**必须没出现**、菜单**必须没弹**。 */
const r4 = await holdAndProbe(`.msg[data-mid="${t2.id}"] .bubble`, 120)
await sleep(800)
const quoteShown4 = await js(`!!document.querySelector('[data-testid="composer-quote"]')`)
ok(
  !quoteShown4,
  '★ 短按 120ms → 不挂引用（引用只从长按菜单进）',
  `引用条 ${quoteShown4}`
)
ok(
  (await js(`document.querySelectorAll('.menu-item').length`)) === 0,
  '短按也不弹菜单（480ms 计时器没跑满）'
)

console.log('\n─── ⑤ 长按中移动手指（= 滚动）不该弹菜单 ───')
await closeMenus()
const r5 = await holdAndProbe(`.msg[data-mid="${t1.id}"] .bubble`, 900, { moveBy: 60 })
ok(r5.ok && r5.menuWhileHeld === 0, '★ 按住后移动 60px 没有弹菜单（防误触生效）', JSON.stringify(r5))

console.log('\n─── ⑥ 图片消息也能长按（原缺陷：只有文字气泡绑了右键） ───')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
const up = await fetch(`${API}/messages/upload`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${me.token}` },
  body: (() => { const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'lp.png'); return fd })(),
})
const upBody = await up.json()
const imgMsg = (await req('/messages', { method: 'POST', token: me.token, body: { conversationId: priv.id, kind: 'image', fileUrl: upBody.url, fileName: '长按用图.png', fileSize: upBody.fileSize } })).data.message
ok(await waitFor(`!!document.querySelector('.msg[data-mid="${imgMsg.id}"]')`, 12000), '图片消息在聊天里')
await sleep(400)
const r6 = await holdAndProbe(`.msg[data-mid="${imgMsg.id}"] .media-bubble, .msg[data-mid="${imgMsg.id}"] .img-bubble, .msg[data-mid="${imgMsg.id}"] .msg-col`, 900)
ok(r6.ok && r6.menuWhileHeld > 0, '★ 图片消息长按也能弹菜单（原来是死区）', JSON.stringify(r6))
if (r6.ok && r6.menuWhileHeld > 0) await shoot(cdp, `${OUT}/02-image-longpress.png`)
await closeMenus()

console.log('\n─── ⑦ 会话列表长按 ───')
await js(`document.querySelector('.rh-back')?.click()`)
await waitFor(`!!document.querySelector('.tabbar')`, 8000)
await sleep(400)
/* 用 label 排掉「新消息」那条 —— 挑一个空会话不影响断言 */
const r7 = await holdAndProbe('.chat-row', 900)
ok(r7.ok && r7.menuWhileHeld > 0, '★ 会话行长按也能弹操作菜单（原来同样只有右键）', JSON.stringify(r7))
if (r7.ok && r7.menuWhileHeld > 0) {
  const rowItems = r7.items
  ok(rowItems.length > 0, '会话菜单里有操作项', JSON.stringify(rowItems))
  await shoot(cdp, `${OUT}/03-chatrow-longpress.png`)
}

const realIssues = issues.filter((t) => !/favicon|Download the React DevTools/i.test(t))
ok(realIssues.length === 0, '控制台无报错', realIssues.slice(0, 2).join(' | '))

try { proc.kill() } catch {}

db.prepare('DELETE FROM favorites WHERE message_id IN (?,?,?)').run(t1.id, t2.id, imgMsg.id)
for (const id of [t1.id, t2.id, imgMsg.id]) db.prepare('DELETE FROM messages WHERE id = ?').run(id)
q.run('DELETE FROM messages WHERE id > ?', msgBaseline)
try { fs.rmSync(`D:/BS-chat-os/server/uploads/${upBody.url.split('/').pop()}`, { force: true }) } catch {}
console.log('\n清理：探针消息与上传文件')
ok(q.get('SELECT COUNT(*) n FROM messages WHERE id > ?', msgBaseline).n === 0, '探针消息已清干净')

console.log(`\n${fail === 0 ? '✅ 长按手势验证全部通过' : '❌ 有失败项'} —— ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)


