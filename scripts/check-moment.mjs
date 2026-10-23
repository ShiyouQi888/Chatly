/**
 * 动态功能端到端自检：展示 / 发布 / 点赞 / 评论与回复 / 编辑 / 可见范围 / 删除
 *
 * 每条断言都找**可观测的证据**，不是「元素存在就行」：
 *   - 图片：`naturalWidth > 0`（破图也会渲染出一个 <img>，只看 src 会全绿）
 *   - 点赞：界面变了之后**再回后端核对**，而且要点两次（取消也要真的落库）
 *   - 可见范围：用三个身份交叉验证 —— 作者自己 / 互关好友 / 单向关注的人。
 *     只测「好友看得到」是不够的：把判定写成 `visibility !== 'private'` 也能过，
 *     必须有一个**应该被挡住**的人真的被挡住。
 *   - 编辑：改完文案要看 `editedAt`，否则「改了个寂寞」也发现不了
 *   - 删除：后端再 GET 一次要 404
 *
 * ⚠️ 全程用带「自检·」标记的临时动态，测完 `purgeMoments()` 真删 + 回收孤儿图。
 *    演示动态（#2~#7）一条都不动。
 *
 * 跑法：node scripts/check-moment.mjs
 */
import fs from 'node:fs'

import { db } from '../server/src/db.js'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'
import { purgeMoments, purgeOrphanUploads } from './lib/debris.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/moment'
const PASS = 'chatly123'

/* 三个身份，缺一不可：
   陈墨 = 作者｜阿杰 = 与陈墨**互关**（应该看得到「仅好友」）｜陈宇 = 单向关注陈墨（应该被挡） */
const AUTHOR = '陈墨'
const FRIEND = '阿杰'
const STRANGER = '陈宇'

const TAG = `自检·动态演示-${Date.now()}`
const TEXT1 = `${TAG} 第一条正文`
const TEXT2 = `${TAG} 改过的正文`
const TOPIC = '自检·话题'
const LOC = '自检·定位'
const CMT1 = '自检·评论一'
const CMT2 = '自检·回复一'

fs.mkdirSync(OUT, { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 后端 ================= */
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
  let d
  try {
    d = JSON.parse(t)
  } catch {
    d = t
  }
  return { status: r.status, d }
}

const author = await login('chenmo')
const friend = await login('ajie')
const stranger = await login('chenyu')

/**
 * 「可见范围」那一段依赖一张**确定**的关系图：
 *   陈墨 ⇄ 阿杰 互关（该看得到）｜陈宇 → 陈墨 单向关注（该被挡）。
 *
 * ⚠️ 不能假设这张图是现成的。**发现页就有「关注」按钮，用户会在预览里随手点** ——
 *    他一关注陈宇，两人就成了互关，陈宇自然能看到「仅好友」的动态，
 *    脚本于是报「不该看到的人看到了」。这个结论**指向完全错误的方向**
 *    （会让人去查可见性判定，而真实原因是测试前提被用户改掉了）。
 *    所以这里显式把四条边摆正，收尾再还原成原样。
 */
const GRAPH = [
  [author, friend, true], // 作者关注好友
  [friend, author, true], // 好友回关 → 互关
  [stranger, author, true], // 陌生人关注作者
  [author, stranger, false], // 但作者**不回关** → 单向
]
const hasEdge = (a, b) =>
  !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(a.user.id, b.user.id)

async function normalizeGraph() {
  const before = GRAPH.map(([a, b]) => hasEdge(a, b))
  for (let i = 0; i < GRAPH.length; i++) {
    const [a, b, want] = GRAPH[i]
    if (before[i] === want) continue
    await j(want ? 'POST' : 'DELETE', `/users/${b.user.id}/follow`, null, a.auth)
  }
  const now = GRAPH.map(([a, b]) => hasEdge(a, b))
  if (JSON.stringify(now) !== JSON.stringify(GRAPH.map((x) => x[2]))) {
    throw new Error(`关系图没能摆正：期望 ${JSON.stringify(GRAPH.map((x) => x[2]))}，实际 ${JSON.stringify(now)}`)
  }
  return before
}
function restoreGraph(before) {
  GRAPH.forEach(([a, b], i) => {
    if (hasEdge(a, b) === before[i]) return
    if (before[i]) db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').run(a.user.id, b.user.id)
    else db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(a.user.id, b.user.id)
  })
}
const graphBefore = await normalizeGraph()

await purgeMoments() // 清掉上一轮可能残留的自检动态
const baselineCount = (await j('GET', '/moments?scope=mine', null, author.auth)).d.moments.length
console.log(`自检开始：作者 ${AUTHOR}（现有 ${baselineCount} 条自己的动态）\n`)

/* ================= 浏览器 ================= */
async function openBrowser(tag, who) {
  const port = await freePort()
  const profileDir = `D:/BS-chat-os/.tmp/chrome-moment-${tag}`
  fs.mkdirSync(profileDir, { recursive: true })
  const proc = launchChrome({ url: APP, port, profileDir })
  const target = await waitAppTarget(port, APP_HOST)
  const issues = []
  const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
    if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
      const text = (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      issues.push(`${e.params.type}: ${text}`.slice(0, 200))
    }
    if (e.method === 'Runtime.exceptionThrown') {
      issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 200))
    }
    if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
      issues.push(`${e.params.entry.level}: ${e.params.entry.text}`.slice(0, 200))
    }
  })
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
    return r.result.value
  }
  const waitFor = async (expr, ms = 12000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      try {
        if (await js(expr)) return true
      } catch {
        /* 页面还在换 context，evaluate 会抛「执行上下文被销毁」—— 等下一轮 */
      }
      await sleep(250)
    }
    return false
  }

  const HELP = `
window.__click = (s) => { const e=document.querySelector(s); if(!e) return false; e.click(); return true }
window.__clickText = (sel, txt) => {
  const e=[...document.querySelectorAll(sel)].find(x=>x.textContent.trim()===txt)
  if(!e) return false; e.click(); return true
}
window.__clickHas = (sel, txt) => {
  const e=[...document.querySelectorAll(sel)].find(x=>x.textContent.includes(txt))
  if(!e) return false; e.click(); return true
}
window.__setValue = (sel, v) => {
  const el = document.querySelector(sel); if(!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
window.__tab = (i) => { const t=[...document.querySelectorAll('.tabbar .tab')][i]; if(!t) return false; t.click(); return true }
window.__toast = () => document.querySelector('.toast')?.textContent.trim() || null
window.__menuItems = () => [...document.querySelectorAll('.menu-item')].map(b=>({
  text: b.textContent.trim(), disabled: b.disabled === true, danger: b.classList.contains('is-danger')
}))
/* ⚠️ 不能写 '.md-input button' —— 顶部那条「回复 X / 取消」提示条里也有一个 button，
   它在 DOM 里排在输入框前面，第一个 button 是「取消」。按 aria-label 取才准。 */
window.__sendComment = () => { const b=document.querySelector('.md-input button[aria-label="发送评论"]'); if(!b) return false; b.click(); return true }

/* 卡片快照：作者名要把「仅好友/仅自己」徽标文字剔除，它们是 <b> 的子节点 */
window.__cards = () => [...document.querySelectorAll('.moment-list .mcard')].map(c=>{
  const bEl = c.querySelector('.mc-meta b')
  const visEl = c.querySelector('.mc-vis')
  const imgs = [...c.querySelectorAll('.mcell img')]
  const acts = [...c.querySelectorAll('.mc-act')]
  return {
    author: bEl ? bEl.textContent.replace(visEl ? visEl.textContent : '', '').trim() : '',
    vis: visEl ? visEl.textContent.trim() : '',
    time: c.querySelector('.mc-meta em')?.textContent.trim() || '',
    topic: c.querySelector('.mc-topic')?.textContent.trim() || '',
    text: c.querySelector('.mc-text')?.textContent.trim() || '',
    imgs: imgs.map(i=>i.getAttribute('src')),
    imgOk: imgs.length > 0 && imgs.every(i=>i.complete && i.naturalWidth > 0),
    hasMusic: !!c.querySelector('.music-card'),
    liked: !!c.querySelector('.mc-act.is-on'),
    like: acts[0]?.querySelector('span')?.textContent.trim() || '',
    cmt: acts[1]?.querySelector('span')?.textContent.trim() || '',
  }
})
window.__cardOf = (t) => [...document.querySelectorAll('.moment-list .mcard')]
  .find(c=>(c.querySelector('.mc-text')?.textContent||'').includes(t))
window.__clickIn = (t, sel) => { const c=window.__cardOf(t); if(!c) return false; const e=c.querySelector(sel); if(!e) return false; e.click(); return true }
window.__inCard = (t, sel) => { const c=window.__cardOf(t); if(!c) return null; const e=c.querySelector(sel); return e ? e.textContent.trim() : null }
window.__isOn = (t) => { const c=window.__cardOf(t); return c ? !!c.querySelector('.mc-act.is-on') : null }
`
  const boot = async (nick) => {
    await js(HELP)
    const up = await waitFor(
      `!!document.querySelector('.lg-card, .login') || !!document.querySelector('.tabbar')`,
      25000
    )
    if (!up) {
      const html = await js(`document.body ? document.body.innerHTML.slice(0, 200) : 'no body'`).catch(() => '?')
      throw new Error(`应用没挂载 —— body: ${html}`)
    }
    await ensureLoggedIn(js)
    await sleep(600)
    await js(HELP)
    // 动态 Tab
    await js(`window.__tab(1)`)
    await waitFor(`!!document.querySelector('.moment-filters')`, 10000)
    await sleep(300)
    await js(HELP)
  }

  return { proc, cdp, js, waitFor, boot, issues, who }
}

const A = await openBrowser('a', AUTHOR)
const B = await openBrowser('b', FRIEND)

try {
  /* ================= 1. 列表展示 ================= */
  console.log('─── 展示 ───')
  await A.boot(AUTHOR)
  ok(await A.waitFor(`document.querySelectorAll('.moment-list .mcard').length > 0`, 12000), '动态列表渲染出卡片')

  /* ⚠️ 不能渲染出来就拍一张：演示库里用户自己发过一张 1.7MB 的 PNG 配图，
     卡片挂上去的时候 <img> 还在解码、naturalWidth 依旧是 0 —— 拍早了会报「破图」，
     而这个结论指向完全错误的方向（会让人去查静态资源/路径，真实原因只是没等它加载完）。
     先等到所有带图的卡片都真正 complete，超时了才让它报破图。 */
  await A.waitFor(
    `(() => {
       const imgs = [...document.querySelectorAll('.moment-list .mcell img')]
       return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0)
     })()`,
    15000
  )
  let cards = await A.js(`window.__cards()`)
  ok(cards.length >= 4, '列表条数 ≥ 4（种子 6 条里能看到的）', String(cards.length))

  const withImg = cards.find((c) => c.imgs.length > 0)
  ok(!!withImg && withImg.imgOk, '图片是真的加载出来了（naturalWidth > 0，不是破图）', withImg ? withImg.imgs[0] : '无图卡')
  ok(
    !!withImg && withImg.imgs.every((s) => s && s.startsWith('/uploads/')),
    '图片地址走 /uploads/（不走外链）',
    JSON.stringify(withImg?.imgs.slice(0, 2))
  )

  ok(
    cards.every((c) => /刚刚|分钟前|小时前|昨天|\d+\/\d+/.test(c.time)),
    '时间是「刚刚 / N 分钟前 / 昨天」这种人话，不是时间戳',
    JSON.stringify(cards.map((c) => c.time))
  )
  ok(cards.some((c) => c.vis === '仅好友'), '「仅好友」的动态带可见范围徽标')
  ok(cards.some((c) => c.vis === '仅自己'), '「仅自己」的动态带可见范围徽标')
  ok(cards.some((c) => c.hasMusic), '音乐动态渲染出音乐卡')
  ok(cards.some((c) => c.topic), '话题渲染出来了', cards.find((c) => c.topic)?.topic)
  await shoot(A.cdp, `${OUT}/01-list.png`)

  /* ================= 2. 筛选 ================= */
  console.log('\n─── 筛选 ───')
  await A.js(`window.__clickText('.moment-filters .chip', '我的')`)
  await A.waitFor(`!!document.querySelector('.moment-list')`, 8000)
  await sleep(900)
  cards = await A.js(`window.__cards()`)
  ok(cards.length > 0 && cards.every((c) => c.author === AUTHOR), `「我的」只剩自己发的`, JSON.stringify([...new Set(cards.map((c) => c.author))]))
  ok(cards.some((c) => c.vis === '仅自己'), '「我的」里能看到仅自己可见那条（其它筛选不该看到）')

  await A.js(`window.__clickText('.moment-filters .chip', '热门')`)
  await sleep(900)
  cards = await A.js(`window.__cards()`)
  /* ⚠️ 「热门」的排序口径是 **赞数 + 2×评论数**（见 server/src/moment.js 的 order 分支），
     不是「只按赞数」。所以断言必须用同一个加权公式：
     一条「1 赞 + 6 评」（13 分）排在「4 赞 + 2 评」（8 分）前面是**正确行为**，
     拿纯赞数去比会把它误判成排序坏了 —— 这里踩过一次，别改回去。 */
  const hotScore = cards.map((c) => (Number(c.like) || 0) + 2 * (Number(c.cmt) || 0))
  ok(
    hotScore.every((n, i) => i === 0 || hotScore[i - 1] >= n),
    '「热门」按热度倒序（赞 + 2×评论 单调不增）',
    JSON.stringify(hotScore)
  )
  /* 再加一条更硬的：前端卡片的**顺序**必须与后端 scope=hot 返回的顺序逐条一致。
     光看加权分单调只能证明「没乱」，证明不了「顺序就是后端那个顺序」——
     前端拿到数组后再自己排一遍（或漏掉排序直接渲染）同样能通过上面那条。 */
  const beHot = (await j('GET', '/moments?scope=hot&limit=20', null, author.auth)).d.moments
  ok(
    JSON.stringify(cards.map((c) => c.text)) === JSON.stringify(beHot.map((m) => m.content)),
    '前端的「热门」顺序与后端返回的顺序逐条一致',
    `${cards.length} 条 vs 后端 ${beHot.length} 条`
  )

  await A.js(`window.__clickText('.moment-filters .chip', '朋友')`)
  await sleep(900)
  await shoot(A.cdp, `${OUT}/02-filters.png`)

  /* ================= 3. 发布 ================= */
  console.log('\n─── 发布 ───')
  await A.js(`window.__click('.moment-head .icon-btn--brand')`)
  ok(await A.waitFor(`!!document.querySelector('.mc-root')`), '点 ➕ 打开发布面板')

  /* 几何断言：整屏面板必须盖住底部导航栏。
     漏出那一条导航栏不只是难看 —— 点它会把编辑到一半的面板直接卸掉。
     光看「.mc-root 存在」永远发现不了，得比两条边的坐标。 */
  const coverBar = async (root) =>
    A.js(`(() => {
      const p = document.querySelector('${root}'); if (!p) return null
      const t = document.querySelector('.tabbar')
      const a = p.getBoundingClientRect()
      const b = t ? t.getBoundingClientRect() : null
      return { panelBottom: Math.round(a.bottom), barBottom: b ? Math.round(b.bottom) : null }
    })()`)
  let geo = await coverBar('.mc-root')
  ok(geo && geo.panelBottom >= geo.barBottom - 1, '发布面板盖住底部导航栏', JSON.stringify(geo))
  ok(
    (await A.js(`document.querySelector('.mc-root h2').textContent.trim()`)) === '发布动态',
    '标题是「发布动态」'
  )
  ok(
    (await A.js(`document.querySelector('.mc-send').disabled`)) === true,
    '空表单时「发布」按钮是禁用的（不让你发一条空的）'
  )
  /* ⚠️ 视频动态已接入（2026-10 起）：它不再是「未接入」项，这里剩 3 项。
     这条断言曾经写死 4 项 —— 功能接进来之后它就成了过期断言，别原样留着。 */
  ok(
    (await A.js(`[...document.querySelectorAll('.mc-pending-item')].length`)) === 3 &&
      (await A.js(`[...document.querySelectorAll('.mc-pending-item')].every(b=>b.disabled)`)),
    '未接入的 3 项（投票/活动/链接）全部 disabled，不做假按钮',
    JSON.stringify(await A.js(`[...document.querySelectorAll('.mc-pending-item')].map(b=>b.textContent.trim())`))
  )
  await shoot(A.cdp, `${OUT}/03-composer.png`)

  await A.js(`window.__setValue('.mc-textarea', ${JSON.stringify(TEXT1)})`)
  /* 话题还是输入框；**定位已经不是输入框了** ——
     2026-10-12 起「定位」是一个 `is-tap` 行，点开的是整屏的选位置面板
     （聊天发位置与动态定位共用同一个 `LocationPicker`，避免两处降级行为漂移）。
     ⚠️ 这条断言原来写的是「给 `.mc-field input[1]` 赋值」，属于**过期断言**：
     它钉的是「定位是文本输入框」这个已经不存在的行为，所以会一直红。
     （LESSONS 里记过同一类坑：改了一处行为要顺手搜一遍钉住它的断言。）
     现在按真实用户路径走：点定位行 → 面板里手输地点名 → 用这个名字。 */
  await A.js(`(() => { const els=[...document.querySelectorAll('.mc-field input')]; return els.length === 2 ? true : els.length })()`)
  await A.js(`window.__setValue('.mc-field input', ${JSON.stringify(TOPIC)})`)
  /* 手输地点名（没有 key 时面板也能用 —— 降级设计就是这么要求的） */
  await A.js(`window.__click('.mc-field.is-tap')`)
  ok(await A.waitFor(`!!document.querySelector('.lp-root')`, 10000), '点定位行打开「选位置」面板')
  await A.waitFor(`document.querySelector('.lp-root')?.dataset.phase === 'ready'`, 15000)
  await A.js(`window.__setValue('[data-testid="lp-search"]', ${JSON.stringify(LOC)})`)
  await A.waitFor(`!!document.querySelector('[data-testid="lp-row-poi"]') || !!document.querySelector('.lp-list li button')`, 8000)
  await A.js(`window.__clickHas('.lp-row', ${JSON.stringify(LOC)})`)
  await sleep(200)
  await A.js(`window.__click('[data-testid="lp-send"]')`)
  ok(await A.waitFor(`!document.querySelector('.lp-root')`, 8000), '选定地点后面板关闭')
  const locShown = await A.js(`document.querySelector('.mc-field.is-set')?.textContent || ''`)
  ok(locShown.includes(LOC), '发布面板上回显了刚选的地点', locShown.trim())
  await A.js(`window.__clickHas('.mc-scope', '仅好友')`)
  ok(
    (await A.js(`!!document.querySelector('.mc-scope.is-on') && document.querySelector('.mc-scope.is-on b').textContent.trim() === '仅好友'`)),
    '可见范围选中「仅好友」'
  )
  ok((await A.js(`document.querySelector('.mc-send').disabled`)) === false, '填了正文后「发布」可用')

  await A.js(`window.__click('.mc-send')`)
  ok(await A.waitFor(`!document.querySelector('.mc-root')`, 8000), '发布后面板自动关闭')
  await sleep(800)

  const mine = (await j('GET', '/moments?scope=mine', null, author.auth)).d.moments
  const created = mine.find((m) => (m.content || '').includes(TAG))
  ok(!!created, '后端真的落库了（能在「我的」里查到）', created ? `#${created.id}` : '没找到')
  ok(created?.visibility === 'friends', '可见范围存成了 friends', created?.visibility)
  ok(created?.topic === TOPIC, '话题存下来了', created?.topic)
  ok(created?.location === LOC, '定位存下来了', created?.location)

  cards = await A.js(`window.__cards()`)
  const fresh = cards.find((c) => c.text.includes(TAG))
  ok(!!fresh, '列表里立刻出现刚发的那条（不用刷新）', fresh?.text.slice(0, 20))
  ok(fresh?.vis === '仅好友', '卡片上带「仅好友」徽标', fresh?.vis)
  ok(fresh?.topic === TOPIC, '卡片上带话题', fresh?.topic)
  await shoot(A.cdp, `${OUT}/04-published.png`)

  /* ================= 4. 点赞 ================= */
  console.log('\n─── 点赞 ───')
  await A.js(`window.__clickIn(${JSON.stringify(TAG)}, '.mc-act')`)
  await sleep(700)
  ok((await A.js(`window.__isOn(${JSON.stringify(TAG)})`)) === true, '点一下变红（乐观更新立刻反馈）')
  ok((await A.js(`window.__inCard(${JSON.stringify(TAG)}, '.mc-act span')`)) === '1', '计数变 1', await A.js(`window.__inCard(${JSON.stringify(TAG)}, '.mc-act span')`))

  let apiOne = (await j('GET', `/moments/${created.id}`, null, author.auth)).d.moment
  ok(apiOne?.liked === true && apiOne?.likeCount === 1, '后端核对：liked=true / likeCount=1', `liked=${apiOne?.liked} n=${apiOne?.likeCount}`)

  await A.js(`window.__clickIn(${JSON.stringify(TAG)}, '.mc-act')`)
  await sleep(700)
  ok((await A.js(`window.__isOn(${JSON.stringify(TAG)})`)) === false, '再点一下取消（不是只能加不能减）')
  apiOne = (await j('GET', `/moments/${created.id}`, null, author.auth)).d.moment
  ok(apiOne?.liked === false && apiOne?.likeCount === 0, '后端核对：取消也真的落库', `liked=${apiOne?.liked} n=${apiOne?.likeCount}`)

  /* ================= 5. 详情 + 评论 + 回复 ================= */
  console.log('\n─── 详情 / 评论 ───')
  await A.js(`(() => { const c=window.__cardOf(${JSON.stringify(TAG)}); if(!c) return false; const b=[...c.querySelectorAll('.mc-act')].find(x=>x.textContent.includes('查看详情')); if(!b) return false; b.click(); return true })()`)
  ok(await A.waitFor(`!!document.querySelector('.md-root')`), '点「查看详情」进详情页')
  geo = await coverBar('.md-root')
  ok(geo && geo.panelBottom >= geo.barBottom - 1, '详情页也盖住底部导航栏', JSON.stringify(geo))
  const detailAuthor = await A.js(`document.querySelector('.md-author-body b')?.textContent.trim()`)
  ok(detailAuthor === AUTHOR, '详情页作者正确', detailAuthor)
  ok(
    (await A.js(`document.querySelector('.md-vis')?.textContent.trim()`))?.includes('仅好友可见'),
    '详情页显示「仅好友可见」',
    await A.js(`document.querySelector('.md-vis')?.textContent.trim()`)
  )
  await shoot(A.cdp, `${OUT}/05-detail.png`)

  await A.js(`window.__setValue('.md-input input', ${JSON.stringify(CMT1)})`)
  await A.js(`window.__sendComment()`)
  ok(
    await A.waitFor(`[...document.querySelectorAll('.md-comments .mdc')].some(e=>e.textContent.includes(${JSON.stringify(CMT1)}))`, 8000),
    '评论发出后出现在评论列表'
  )
  const cmtApi = (await j('GET', `/moments/${created.id}/comments`, null, author.auth)).d.comments
  ok(cmtApi?.length === 1 && cmtApi[0].content === CMT1, '后端核对：评论落库', `n=${cmtApi?.length}`)

  // 回复自己这条评论
  await A.js(`(() => { const e=[...document.querySelectorAll('.md-comments .mdc')].find(x=>x.textContent.includes(${JSON.stringify(CMT1)})); if(!e) return false; const b=[...e.querySelectorAll('.mdc-acts button')].find(x=>x.textContent.trim()==='回复'); if(!b) return false; b.click(); return true })()`)
  ok(await A.waitFor(`!!document.querySelector('.md-reply')`), '点「回复」出现回复提示条')
  ok(
    (await A.js(`document.querySelector('.md-input input')?.placeholder`))?.includes(`回复 ${AUTHOR}`),
    '输入框 placeholder 变成「回复 陈墨…」',
    await A.js(`document.querySelector('.md-input input')?.placeholder`)
  )
  await A.js(`window.__setValue('.md-input input', ${JSON.stringify(CMT2)})`)
  await A.js(`window.__sendComment()`)
  ok(
    await A.waitFor(`!!document.querySelector('.mdc-kids') && document.querySelector('.mdc-kids').textContent.includes(${JSON.stringify(CMT2)})`, 8000),
    '回复挂在父评论下面（.mdc-kids）而不是平级'
  )
  ok(
    await A.js(`!!document.querySelector('.mdc-reply') && document.querySelector('.mdc-reply').textContent.includes('回复')`),
    '回复带上「回复 陈墨：」前缀'
  )
  await shoot(A.cdp, `${OUT}/06-comments.png`)

  // 删掉回复：作者是陈墨，动态也是陈墨的，两个条件都满足
  await A.js(`(() => { const k=document.querySelector('.mdc-kids .mdc'); if(!k) return false; const b=k.querySelector('.mdc-acts .is-danger'); if(!b) return false; b.click(); return true })()`)
  ok(
    await A.waitFor(`![...document.querySelectorAll('.md-comments')].some(e=>e.textContent.includes(${JSON.stringify(CMT2)}))`, 8000),
    '删回复后它真的消失了'
  )
  const afterDel = (await j('GET', `/moments/${created.id}/comments`, null, author.auth)).d.comments
  ok(afterDel?.length === 1, '后端核对：只剩 1 条评论', `n=${afterDel?.length}`)

  await A.js(`window.__click('.md-back')`)
  await A.waitFor(`!document.querySelector('.md-root')`)
  await sleep(600)
  ok(
    (await A.js(`window.__inCard(${JSON.stringify(TAG)}, '.mc-act:nth-of-type(2) span')`)) === '1',
    '返回列表，评论数同步成 1',
    await A.js(`window.__inCard(${JSON.stringify(TAG)}, '.mc-act:nth-of-type(2) span')`)
  )

  /* ================= 6. 编辑 ================= */
  console.log('\n─── 编辑 ───')
  await A.js(`window.__clickIn(${JSON.stringify(TAG)}, '.mc-more')`)
  await A.waitFor(`!!document.querySelector('.menu-item')`)
  let items = await A.js(`window.__menuItems()`)
  ok(items.some((i) => i.text === '编辑' && !i.disabled), '自己的动态菜单里有「编辑」')
  ok(items.some((i) => i.text === '删除' && i.danger), '自己的动态菜单里有「删除」（标红）')
  ok(
    items.filter((i) => /未接入/.test(i.text)).length === 2 &&
      items.filter((i) => /未接入/.test(i.text)).every((i) => i.disabled),
    '「分享 / 举报」标注未接入且禁用',
    JSON.stringify(items.map((i) => i.text + (i.disabled ? '(禁用)' : '')))
  )

  await A.js(`window.__clickText('.menu-item', '编辑')`)
  ok(await A.waitFor(`!!document.querySelector('.mc-root')`), '打开编辑面板')
  ok(
    (await A.js(`document.querySelector('.mc-root h2').textContent.trim()`)) === '编辑动态',
    '标题是「编辑动态」'
  )
  ok(
    (await A.js(`document.querySelector('.mc-textarea').value`))?.includes(TAG),
    '编辑面板预填了原文（不是空表单）'
  )
  ok(
    (await A.js(`document.querySelector('.mc-scope.is-on b')?.textContent.trim()`)) === '仅好友',
    '编辑面板预填了可见范围'
  )
  await shoot(A.cdp, `${OUT}/07-edit.png`)

  await A.js(`window.__setValue('.mc-textarea', ${JSON.stringify(TEXT2)})`)
  await A.js(`window.__click('.mc-send')`)
  ok(await A.waitFor(`!document.querySelector('.mc-root')`, 8000), '保存后面板关闭')
  await sleep(800)
  ok(
    await A.waitFor(`[...document.querySelectorAll('.mc-text')].some(e=>e.textContent.includes(${JSON.stringify(TEXT2)}))`, 8000),
    '列表里的文案立刻变了'
  )
  const edited = (await j('GET', `/moments/${created.id}`, null, author.auth)).d.moment
  ok(edited?.content === TEXT2, '后端核对：正文已更新', JSON.stringify(edited?.content?.slice(0, 20)))
  ok(!!edited?.editedAt, '后端核对：editedAt 有值（能显示「已编辑」）', String(edited?.editedAt))

  /* ================= 7. 「我」页的「我的动态」子页 =================
     这一页读的也是真数据 —— 以前渲染的是 mock 里的原型动态，
     动态接后端之后那就是「列着一堆不存在的内容」。 */
  console.log('\n─── 我的动态子页 ───')
  await A.js(`window.__tab(3)`)
  await A.waitFor(`!!document.querySelector('.me-stats')`, 10000)
  await sleep(1200)
  const statNum = await A.js(`document.querySelectorAll('.me-stats b')[1]?.textContent.trim()`)
  ok(statNum != null && Number(statNum) >= 3, '「我」页的动态统计是真数（不是 mock 里那个 18）', statNum)

  await A.js(`document.querySelectorAll('.me-stats button')[1].click()`)
  ok(await A.waitFor(`!!document.querySelector('.subpage .mini-post')`, 10000), '打开「我的动态」子页并列出条目')
  const posts = await A.js(
    `[...document.querySelectorAll('.subpage .mini-post')].map(e=>e.querySelector('p')?.textContent.trim()||'')`
  )
  ok(posts.some((t) => t.includes(TAG)), '子页里有刚发布的那条（读的是同一个后端）', JSON.stringify(posts.map((t) => t.slice(0, 12))))
  ok(!posts.some((t) => t.includes('海边的风')), '子页里没有别人的动态（scope=mine）')
  ok(await A.js(`!!document.querySelector('.subpage .mp-media img')`), '带图的动态在子页里显示缩略图')
  geo = await coverBar('.subpage')
  ok(geo && geo.panelBottom >= geo.barBottom - 1, '「我的动态」子页盖住底部导航栏', JSON.stringify(geo))
  await shoot(A.cdp, `${OUT}/10-myposts.png`)

  await A.js(`window.__click('.mp-manage')`)
  ok(await A.waitFor(`!!document.querySelector('.moment-filters')`, 10000), '点「去动态页编辑 / 删除」跳回动态 Tab')
  await sleep(900)
  ok(
    (await A.js(`document.querySelector('.moment-filters .chip.is-active')?.textContent.trim()`)) === '我的',
    '跳过去时筛选已经切到「我的」'
  )
  ok(
    await A.waitFor(
      `[...document.querySelectorAll('.mc-text')].some(e=>e.textContent.includes(${JSON.stringify(TEXT2)}))`,
      10000
    ),
    '并且「我的」列表里能看到刚发的那条'
  )

  /* ================= 8. 可见范围（三个身份交叉验证） ================= */
  console.log('\n─── 可见范围 ───')
  const friendList = (await j('GET', '/moments?scope=friends', null, friend.auth)).d.moments
  ok(
    friendList.some((m) => m.id === created.id),
    `互关好友 ${FRIEND} **看得到**这条「仅好友」动态`
  )
  const strangerList = (await j('GET', '/moments?scope=friends', null, stranger.auth)).d.moments
  ok(
    !strangerList.some((m) => m.id === created.id),
    `单向关注的 ${STRANGER} **看不到**这条「仅好友」动态（不是好友就该被挡）`
  )
  /* 详情对看不见的人返回 404 而不是 403 —— 404 与「不存在」同码，
     不泄漏「这条其实是有的，只是你看不到」。断言只看「拿不到内容」。 */
  const strangerOne = await j('GET', `/moments/${created.id}`, null, stranger.auth)
  ok(strangerOne.status === 404, '非好友直接访问详情拿不到内容（404，与「不存在」同码不泄漏存在性）', String(strangerOne.status))

  const privateOne = (await j('GET', '/moments?scope=mine', null, author.auth)).d.moments.find(
    (m) => m.visibility === 'private'
  )
  if (privateOne) {
    const r = await j('GET', `/moments/${privateOne.id}`, null, friend.auth)
    ok(r.status === 404, `好友也看不到「仅自己」那条（#${privateOne.id}）`, String(r.status))
  }

  // B（阿杰）界面上也要真的看得到
  await B.boot(FRIEND)
  await B.waitFor(`document.querySelectorAll('.moment-list .mcard').length > 0`, 12000)
  const bHas = await B.waitFor(
    `[...document.querySelectorAll('.mc-text')].some(e=>e.textContent.includes(${JSON.stringify(TEXT2)}))`,
    10000
  )
  const bDump = await B
    .js(
      `({ n: document.querySelectorAll('.moment-list .mcard').length,
          tab: [...document.querySelectorAll('.tabbar .tab')].findIndex(t=>t.classList.contains('is-on')),
          texts: [...document.querySelectorAll('.mc-text')].map(e=>e.textContent.slice(0,20)) })`
    )
    .catch(() => null)
  ok(bHas, `B（${FRIEND}）的界面上也能看到这条`, JSON.stringify(bDump))
  const bMenu = await B.js(`(() => { const c=window.__cardOf(${JSON.stringify(TEXT2)}); if(!c) return null; c.querySelector('.mc-more').click(); return true })()`)
  await B.waitFor(`!!document.querySelector('.menu-item')`)
  items = await B.js(`window.__menuItems()`)
  ok(
    !items.some((i) => i.text === '编辑' || i.text === '删除'),
    `B 的菜单里**没有**编辑 / 删除（别人的动态不能改）`,
    JSON.stringify(items.map((i) => i.text))
  )
  await shoot(B.cdp, `${OUT}/08-friend.png`)
  await B.js(`window.__clickText('.menu-item', '取消')`).catch(() => {})
  await B.js(`(() => { const b=document.querySelector('.menu-cancel'); if(b) b.click(); return true })()`)
  await sleep(300)

  /* ================= 9. 删除 ================= */
  console.log('\n─── 删除 ───')
  await A.js(`window.__clickIn(${JSON.stringify(TEXT2)}, '.mc-more')`)
  await A.waitFor(`!!document.querySelector('.menu-item')`)
  await A.js(`window.__clickText('.menu-item', '删除')`)
  ok(
    await A.waitFor(`[...document.querySelectorAll('.sheet-title')].some(e=>e.textContent.includes('删除这条动态'))`, 6000),
    '弹出「删除这条动态？」二次确认'
  )
  await A.js(`window.__click('.menu-item.is-danger')`)
  ok(
    await A.waitFor(`![...document.querySelectorAll('.mc-text')].some(e=>e.textContent.includes(${JSON.stringify(TEXT2)}))`, 8000),
    '确认后从列表消失'
  )
  const gone = await j('GET', `/moments/${created.id}`, null, author.auth)
  ok(gone.status === 404, '后端核对：GET 返回 404', String(gone.status))
  await shoot(A.cdp, `${OUT}/09-deleted.png`)

  /* ================= 收尾 ================= */
  const finalMine = (await j('GET', '/moments?scope=mine', null, author.auth)).d.moments
  ok(finalMine.length === baselineCount, '自己动态的数量回到基线（没留下痕迹）', `${baselineCount} → ${finalMine.length}`)
} catch (e) {
  console.error('\n💥 自检中断：', e.message)
  failures++
} finally {
  A.proc.kill()
  B.proc.kill()
  restoreGraph(graphBefore)
  const p = await purgeMoments()
  await purgeOrphanUploads({ quiet: true })
  if (p.moments) console.log(`\n已清理临时动态 ${p.moments} 条（媒体 ${p.media} / 赞 ${p.likes} / 评论 ${p.comments}）`)

  const noise = /favicon|DevTools|ExperimentalWarning/i
  for (const [who, br] of [['A', A], ['B', B]]) {
    const real = [...new Set(br.issues.filter((x) => !noise.test(x)))]
    if (real.length) {
      console.log(`\n❌ ${who} 端控制台有 ${real.length} 条问题：`)
      real.forEach((x) => console.log('  •', x))
      failures += real.length
    }
  }
}

console.log(`\n${failures === 0 ? '✅ 动态自检全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
