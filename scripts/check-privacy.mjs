/**
 * 隐私设置端到端自检：添加好友三开关 + 在线状态可见 + 手机号不泄露
 *
 * 跑法：node scripts/check-privacy.mjs      （需要 5198 与 3002 都在跑）
 *
 * ## 这支自检要证明什么
 * `user_settings` 是「键值随便存」的表 —— 所以**「开关拨过去了」不算证据**。
 * 这里要证明的是「别人真的搜不到我 / 加不上我」，即**站在另一个账号的视角**做断言。
 *
 * ## 三条纪律（本项目踩过坑的地方）
 *  1. **每条负向断言都配一个正向对照。**「搜不到林小夏」可能是真的被拦了，
 *     也可能是整个搜索接口挂了 / 关键词写错了。所以同一时刻必须再搜一个
 *     **不该被拦**的人（阿杰），他必须搜得到。没有这个对照，负向断言等于什么都没说。
 *  2. **403 之后要回库确认。**「接口回 403」和「库里没写」是两件事；
 *     也可能出现「接口报错但事务已经提交」。所以 assert 完状态码再查 `follows`。
 *  3. **收尾按基线还原。**设置与关注关系都先记下原值，最后恢复原样，
 *     哪怕中途抛异常也要恢复（用 finally）。否则跑一次自检就把演示账号
 *     留在「别人搜不到我」的状态里，后面几支自检会莫名其妙地红。
 */
import fs from 'node:fs'
/* ⚠️ 这里用的是**异步**的 q，不是 qSync。
   理由：本脚本要能在 `DB_DRIVER=postgres` 下原样跑一遍（同一套用例两种数据库都过），
   而 qSync / db 是 SQLite 专有的同步直连，PG 下会直接抛错。
   凡是想「两种驱动都能跑」的自检，回库核对就必须走异步 q。 */
import { q, ready as dbReady } from '../server/src/db.js'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/privacy'
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
  try {
    d = JSON.parse(t)
  } catch {
    d = t
  }
  return { status: r.status, data: d }
}
const login = async (u) => {
  const r = await req('/auth/login', { method: 'POST', body: { username: u, password: 'chatly123' } })
  if (!r.data?.token) throw new Error(`${u} 登录失败：${JSON.stringify(r.data)}`)
  return r.data
}

/* ---- 一个只用来「让某个账号真的在线」的 WS 连接 ----
   presence 断言的**前提**是有人真的连着；没有这个连接，
   「online=false」既可能是隐私开关生效，也可能只是因为压根没人连上。 */
const wsMod = await import('../server/node_modules/ws/index.js')
const WebSocket = wsMod.WebSocket || wsMod.default
const sockets = []
async function openWs(token) {
  const ws = new WebSocket(`ws://127.0.0.1:3002/ws?token=${encodeURIComponent(token)}`)
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  sockets.push(ws)
  return ws
}
function closeWs() {
  for (const ws of sockets) {
    try {
      ws.close()
    } catch {}
  }
  sockets.length = 0
}

/* ================= 准备 ================= */
await dbReady() /* PG 驱动下建表 / 迁移都在这一步 */
const A = await login('chenmo') // 施动者：要去看别人、加别人
const B = await login('linxiaoxia') // 被保护的人：开关都在她身上拨
const C = await login('ajie') // 正向对照：他的开关全程保持默认（全开）

const AID = A.user.id
const BID = B.user.id
const CID = C.user.id

const phoneOf = async (id) => (await q.get('SELECT phone FROM users WHERE id = ?', id))?.phone
const B_PHONE = await phoneOf(BID)
const C_PHONE = await phoneOf(CID)

const KEYS = ['add_friend_by_phone', 'add_friend_by_qr', 'add_friend_by_search', 'online_status_visible']
const original = {}
for (const k of KEYS) {
  const row = await q.get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', BID, k)
  original[k] = row ? JSON.parse(row.value) : true
}
const followBaseline = !!(await q.get('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', AID, BID))

const setFlag = (token, key, value) =>
  req(`/settings/${key}`, { method: 'PUT', token, body: { value } })

/** 收尾：把 B 的设置与 A→B 的关注关系恢复成进入时的样子 */
async function restore() {
  let restored = 0
  for (const k of KEYS) {
    const r = await setFlag(B.token, k, original[k])
    if (r.status === 200) restored++
  }
  if (followBaseline) {
    await req(`/users/${BID}/follow`, { method: 'POST', token: A.token })
  } else {
    await req(`/users/${BID}/follow`, { method: 'DELETE', token: A.token })
  }
  return restored
}

const searchAs = async (token, keyword) => (await req(`/users/search?q=${encodeURIComponent(keyword)}`, { token })).data
const namesIn = (d) => (d.users || []).map((u) => u.username)
const lookupAs = async (token, username, from) =>
  req(`/users/by-username/${encodeURIComponent(username)}${from ? `?from=${from}` : ''}`, { token })
const followAs = async (token, id, source) =>
  req(`/users/${id}/follow`, { method: 'POST', token, body: source ? { source } : {} })
const unfollowAs = (token, id) => req(`/users/${id}/follow`, { method: 'DELETE', token })
const followRowExists = async () =>
  !!(await q.get('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?', AID, BID))

console.log(`\n施动者 chenmo(#${AID}) · 被保护者 linxiaoxia(#${BID}) · 对照 ajie(#${CID})`)
console.log(`手机号：B=${B_PHONE} C=${C_PHONE}\n`)

try {
  /* ================= ① 正向基线：全开时一切都该通 ================= */
  console.log('─── ① 正向基线（三项都开着，控件全通）───')
  for (const k of KEYS) await setFlag(B.token, k, true)
  await sleep(300)

  const s1 = await searchAs(A.token, '林小夏')
  ok(namesIn(s1).includes('linxiaoxia'), '★ 搜昵称能搜到 B（后面「搜不到」才是有效对照）', JSON.stringify(namesIn(s1)))

  const s2 = await searchAs(A.token, B_PHONE)
  ok(s2.by === 'phone', '手机号形态的查询被识别成按手机号找', `by=${s2.by}`)
  ok(namesIn(s2).includes('linxiaoxia'), '★ 按 B 的手机号能搜到 B', JSON.stringify(namesIn(s2)))

  const q1 = await lookupAs(A.token, 'linxiaoxia', 'qr')
  ok(q1.status === 200 && q1.data.addable?.allowed === true, '扫二维码路径：可以加', JSON.stringify(q1.data.addable))
  const m1 = await lookupAs(A.token, 'linxiaoxia', 'search')
  ok(m1.status === 200 && m1.data.addable?.allowed === true, '手输 ID 路径：可以加', JSON.stringify(m1.data.addable))

  const f0 = await followAs(A.token, BID, 'search')
  ok(f0.status === 200, '带 source=search 关注成功', `status=${f0.status}`)
  ok((await followRowExists()), '★ 回库确认 follows 里真的多了一行（不是只回了 200）')
  await unfollowAs(A.token, BID)
  ok(!(await followRowExists()), '取消关注后那一行真的删掉了')

  /* ================= ② add_friend_by_search ================= */
  console.log('\n─── ② 关掉「通过搜索添加」───')
  await setFlag(B.token, 'add_friend_by_search', false)
  await sleep(300)

  const s3 = await searchAs(A.token, '林小夏')
  ok(!namesIn(s3).includes('linxiaoxia'), '★ 搜昵称搜不到 B 了（后端过滤，前端拿不到）', JSON.stringify(namesIn(s3)))
  const s4 = await searchAs(A.token, '阿杰')
  ok(namesIn(s4).includes('ajie'), '★ 正向对照：同一时刻「阿杰」照样搜得到（排除搜索接口整体失效）', JSON.stringify(namesIn(s4)))

  const f1 = await followAs(A.token, BID, 'search')
  ok(f1.status === 403 && f1.data.code === 'privacy_blocked', '带 source=search 关注 → 403 且标明 privacy_blocked', `${f1.status} ${JSON.stringify(f1.data)}`)
  ok(!(await followRowExists()), '★ 403 之后回库确认：follows 里没有偷偷写进去')
  ok(!!f1.data.error && /搜索/.test(f1.data.error), '报错文案写清了是哪个开关', f1.data.error)

  const f2 = await followAs(A.token, BID)
  ok(f2.status === 200, '★ 不带 source 的关注不受影响（拦的是渠道，不是这个人）', `status=${f2.status}`)
  await unfollowAs(A.token, BID)
  ok(!(await followRowExists()), '（收尾）那条不带 source 的关注也撤掉了')

  const m2 = await lookupAs(A.token, 'linxiaoxia', 'search')
  ok(m2.status === 200 && m2.data.addable?.allowed === false, '手输 ID 仍能看到是谁，但 addable=false', JSON.stringify(m2.data.addable))
  ok(/搜索/.test(m2.data.addable?.reason || ''), '原因指向「通过搜索添加」', m2.data.addable?.reason)
  const q2 = await lookupAs(A.token, 'linxiaoxia', 'qr')
  ok(q2.data.addable?.allowed === true, '对照：二维码那条路径仍然开着', JSON.stringify(q2.data.addable))

  /* ================= ③ add_friend_by_qr ================= */
  console.log('\n─── ③ 关掉「通过二维码添加」───')
  await setFlag(B.token, 'add_friend_by_qr', false)
  await sleep(300)

  const q3 = await lookupAs(A.token, 'linxiaoxia', 'qr')
  ok(q3.status === 200 && q3.data.addable?.allowed === false, '扫码路径 addable=false', JSON.stringify(q3.data.addable))
  ok(/二维码/.test(q3.data.addable?.reason || ''), '原因指向「通过二维码添加」', q3.data.addable?.reason)
  const f3 = await followAs(A.token, BID, 'qr')
  ok(f3.status === 403 && f3.data.code === 'privacy_blocked', '带 source=qr 关注 → 403', `${f3.status}`)
  ok(!(await followRowExists()), '回库确认没有写入')

  const plain = await lookupAs(A.token, 'linxiaoxia', null)
  ok(plain.data.addable?.allowed === true, '对照：不带 from 的纯资料查看不设闸', JSON.stringify(plain.data.addable))
  const f4 = await followAs(A.token, BID, 'group')
  ok(f4.status === 200, '对照：未知渠道（群里点关注）不设闸', `status=${f4.status}`)
  await unfollowAs(A.token, BID)

  /* ================= ④ add_friend_by_phone ================= */
  console.log('\n─── ④ 关掉「通过手机号添加」───')
  await setFlag(B.token, 'add_friend_by_phone', false)
  await sleep(300)

  const s5 = await searchAs(A.token, B_PHONE)
  ok(!namesIn(s5).includes('linxiaoxia'), '★ 按 B 的手机号搜不到 B 了', JSON.stringify(namesIn(s5)))
  const s6 = await searchAs(A.token, C_PHONE)
  ok(namesIn(s6).includes('ajie'), '★ 正向对照：按阿杰的手机号照样搜得到', JSON.stringify(namesIn(s6)))

  await setFlag(B.token, 'add_friend_by_phone', true)
  await sleep(300)
  const s7 = await searchAs(A.token, B_PHONE)
  ok(namesIn(s7).includes('linxiaoxia'), '★ 开关打回来之后又搜得到了（证明是开关在起作用，不是手机号写错）', JSON.stringify(namesIn(s7)))

  /* ================= ⑤ 手机号不泄露 ================= */
  console.log('\n─── ⑤ 手机号只在「我」这里出现 ───')
  const meA = await req('/auth/me', { token: A.token })
  ok(meA.data.user.phone === (await phoneOf(AID)), '自己的 /auth/me 有手机号', String(meA.data.user.phone))

  const viewB = await req(`/users/${BID}`, { token: A.token })
  ok(!('phone' in (viewB.data.user || {})), '★ 别人看我的资料里**没有** phone 字段', Object.keys(viewB.data.user || {}).join(','))
  const viewSelf = await req(`/users/${AID}`, { token: A.token })
  ok(viewSelf.data.user.phone === (await phoneOf(AID)), '看自己的资料才有手机号（isSelf 才补）')

  const convs = (await req('/conversations', { token: A.token })).data.conversations
  const g = convs.find((c) => c.type === 'group')
  if (g) {
    const mem = await req(`/conversations/${g.id}/members`, { token: A.token })
    const list = mem.data.members || mem.data.users || []
    ok(list.length > 0 && list.every((m) => !('phone' in (m.user || m))), '群成员列表里也没有 phone', `成员 ${list.length} 人`)
  } else {
    ok(false, '群成员列表里也没有 phone', '（没找到演示群，这条没跑）')
  }
  const s8 = await searchAs(A.token, '阿杰')
  ok(s8.users.every((u) => !('phone' in u)), '搜索结果里也没有 phone', JSON.stringify(Object.keys(s8.users[0] || {})))

  /* ================= ⑥ 在线状态可见 ================= */
  console.log('\n─── ⑥ 在线状态可见（配 Redis presence）───')
  await setFlag(B.token, 'online_status_visible', true)
  await sleep(300)
  const wsB = await openWs(B.token)
  await sleep(700)
  const p1 = await req(`/users/${BID}`, { token: A.token })
  ok(p1.data.online === true, '★ B 在线且开着可见 → A 看到 online=true（正对照）', String(p1.data.online))

  await setFlag(B.token, 'online_status_visible', false)
  await sleep(600)
  const p2 = await req(`/users/${BID}`, { token: A.token })
  ok(p2.data.online === false, '★ B 仍连着但关掉了可见 → A 看到 online=false', String(p2.data.online))
  const listAs = await req('/users', { token: A.token })
  const rowB = (listAs.data.users || []).find((u) => u.id === BID)
  ok(rowB && rowB.online === false, '用户列表里的 online 也跟着变（不是只改了一个接口）', JSON.stringify(rowB))
  const meSelf = await req(`/users/${BID}`, { token: B.token })
  ok(meSelf.data.online === true, '对照：自己看自己仍然是「在线」（这个开关管的是别人）', String(meSelf.data.online))

  await setFlag(B.token, 'online_status_visible', true)
  await sleep(500)

  /* ================= ⑦ 浏览器：搜索面板「找人」 ================= */
  console.log('\n─── ⑦ 界面：搜索面板「找人」 ───')
  const port = await freePort()
  const profileDir = 'D:/BS-chat-os/.tmp/chrome-privacy'
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch (e) {
    console.log(`（临时 profile 未能清空，继续复用：${String(e.message).slice(0, 60)}）`)
  }
  fs.mkdirSync(profileDir, { recursive: true })
  const proc = launchChrome({ url: APP, port, profileDir })
  const issues = []
  let browserOk = false
  try {
    const target = await waitAppTarget(port, APP_HOST)
    const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
      if (e.method === 'Runtime.exceptionThrown') issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 300))
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') issues.push('error: ' + e.params.entry.text.slice(0, 200))
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
        } catch {}
        await sleep(200)
      }
      return false
    }

    ok(await waitFor(`!!document.querySelector('.lg-demo-list button') || !!document.querySelector('.tabbar')`), '应用挂载')
    if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
      await js(`[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨'))?.click()`)
    }
    ok(await waitFor(`!!document.querySelector('.tabbar')`, 10000), '登录后进入主界面')

    /* 打开搜索面板 */
    await js(`document.querySelector('[aria-label="搜索"]')?.click() || document.querySelector('.chat-search')?.click()`)
    ok(await waitFor(`!!document.querySelector('.search-panel')`, 8000), '打开发搜索面板')
    browserOk = true

    /* ⚠️ 必须先清空再填。
       直接 set 成**同一个字符串**时 React 的 onChange 不会触发（值没变），
       于是 effect 不重跑、列表还是上一次的结果 —— 会误判成「开关没生效」。
       （这反过来说明界面上结果确实是「按关键词请求」的，不是本地全量过滤。） */
    const typeQ = async (kw) => {
      const setValue = (v) =>
        js(`(() => {
        const i = document.querySelector('.sp-field input')
        if (!i) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(i, ${JSON.stringify(v)})
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await setValue('')
      await sleep(120)
      await setValue(kw)
      await sleep(1200) /* 300ms 防抖 + 一次往返 */
    }

    /* 先把 B 的搜索开关打开，界面上应该能搜到人 */
    await setFlag(B.token, 'add_friend_by_search', true)
    await sleep(200)
    await typeQ('林小夏')
    ok(await waitFor(`!!document.querySelector('[data-uid="${BID}"]')`, 8000), '★ 找人组里出现了林小夏（正向对照）')
    ok(await js(`!!document.querySelector('[data-testid="people-follow-${BID}"]')`), '每行带「关注」按钮')
    await shoot(cdp, `${OUT}/01-search-people.png`)

    /* 关掉之后应该搜不到了，但对照人物还在 */
    await setFlag(B.token, 'add_friend_by_search', false)
    await sleep(300)
    await typeQ('林小夏')
    await sleep(600)
    const gone = await js(`!document.querySelector('[data-uid="${BID}"]')`)
    ok(gone, '★ 关掉「通过搜索添加」后，界面上搜不到林小夏了')
    await typeQ('阿杰')
    ok(await waitFor(`!!document.querySelector('[data-uid="${CID}"]')`, 8000), '★ 正向对照：同一次会话里「阿杰」还在（排除整个找人组没渲染）')
    await shoot(cdp, `${OUT}/02-search-blocked.png`)

    /* 扫一扫 → 手输 ID：被拦时按钮换成写明原因的禁用态 */
    await js(`document.querySelector('.sp-head .sub-back')?.click()`)
    await waitFor(`!document.querySelector('.search-panel')`, 6000)
    await js(`document.querySelector('[aria-label="扫一扫"]')?.click() || document.querySelector('.chat-scan')?.click()`)
    ok(await waitFor(`!!document.querySelector('.scan')`, 8000), '打开发扫一扫')
    await js(`[...document.querySelectorAll('.scan-act')].find(b=>b.textContent.includes('手动输 ID'))?.click()`)
    ok(await waitFor(`!!document.querySelector('.scan-manual input')`, 6000), '切到手动输 ID')

    /* ⚠️ 查过一次之后 `.scan-manual input` 就**不在 DOM 里**了 ——
       识别到结果时整块表单被结果卡替换掉了。所以第二次查之前必须先点
       「再扫一次」把表单要回来，否则 `setter.call(undefined, …)` 会抛
       `TypeError: Illegal invocation`（信息量很低的那个经典报错）。 */
    const lookup = async (username) => {
      if (await js(`!!document.querySelector('[data-testid="scan-again"]')`)) {
        await js(`document.querySelector('[data-testid="scan-again"]').click()`)
        await waitFor(`!!document.querySelector('.scan-manual input')`, 6000)
      }
      const filled = await js(`(() => {
        const i = document.querySelector('.scan-manual input')
        if (!i) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(i, ${JSON.stringify(username)})
        i.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      if (!filled) throw new Error('手动输 ID 的输入框不在 DOM 里（上一张结果卡没被关掉？）')
      await js(`[...document.querySelectorAll('.scan-btn')].find(b=>b.textContent.trim()==='查找')?.click()`)
      await sleep(1200)
    }

    await lookup('linxiaoxia')
    ok(await waitFor(`!!document.querySelector('[data-testid="scan-follow-blocked"]')`, 8000), '★ 对方关掉搜索添加 → 「加好友」变成禁用的「无法加为好友」')
    ok(await js(`!!document.querySelector('[data-testid="scan-follow-reason"]')`), '并把原因写在页面上（不是静默失效）')
    const reason = await js(`document.querySelector('[data-testid="scan-follow-reason"]')?.textContent.trim()`)
    ok(/搜索|二维码/.test(reason || ''), '原因文案指向具体开关', String(reason))
    ok(!(await js(`!!document.querySelector('[data-testid="scan-follow"]')`)), '此时不存在可点的「加好友」按钮（不是只把它变灰）')
    await shoot(cdp, `${OUT}/03-scan-blocked.png`)

    /* ★ 正向对照必须挑一个**陈墨还没关注**的人。
       一开始拿阿杰当对照是错的：种子里陈墨本来就关注了他，
       扫出来显示的是「已加为好友」（`.scan-btn--done`）—— 拿它当正对照，
       会把「按钮正确反映出已关注」误判成「加好友按钮没渲染」。
       所以拆成两条：已关注的显示「已加为好友」，未关注的显示「加好友」。 */
    await lookup('ajie')
    ok(await waitFor(`!!document.querySelector('.scan-btn--done')`, 8000), '对照：已关注的人显示「已加为好友」', await js(`document.querySelector('.scan-btn--done')?.textContent.trim()`))
    await lookup('shenxu')
    ok(
      await waitFor(`!!document.querySelector('[data-testid="scan-follow"]')`, 8000),
      '★ 正向对照：一个还没关注的人，「加好友」按钮正常在（排除整个结果卡没渲染）'
    )
    await shoot(cdp, `${OUT}/04-scan-allowed.png`)

    const realIssues = issues.filter((t) => !/favicon|Download the React DevTools/i.test(t))
    ok(realIssues.length === 0, '控制台无报错 / 未捕获异常', realIssues.slice(0, 2).join(' | '))
  } finally {
    try {
      proc.kill()
    } catch {}
  }
  ok(browserOk, '浏览器部分跑到位')
} catch (e) {
  /* ⚠️ 必须把中断原因打出来：`finally` 里如果不抛、脚本又直接走到
     `process.exit`，那「中途崩了」和「跑完但全是红」长得一模一样。 */
  fail++
  console.log(`\n❌ 自检中途中断：${e?.message}\n${String(e?.stack || '').split('\n').slice(0, 6).join('\n')}`)
} finally {
  /* ⚠️ 还原放在 finally：中途任何一步抛异常，都不能把演示账号留在
     「别人搜不到我」「隐身」的状态里 —— 那样后面几支自检会以奇怪的理由变红。 */
  const n = await restore()
  await sleep(300)
  const bad = []
  for (const k of KEYS) {
    const row = await q.get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', BID, k)
    const now = row ? JSON.parse(row.value) : true
    if (now !== original[k]) bad.push(`${k}: ${original[k]} -> ${now}`)
  }
  ok(bad.length === 0, `收尾：B 的隐私设置已还原（${n}/4 项）`, bad.join('; '))
  ok((await followRowExists()) === followBaseline, '收尾：A→B 的关注关系回到基线', `${followBaseline} vs ${(await followRowExists())}`)
  closeWs()
}

console.log(`\n${fail === 0 ? '✅ 隐私设置自检全部通过' : '❌ 有失败项'} —— ${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
