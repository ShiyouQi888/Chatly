/**
 * 表情面板 —— 真实端到端验证
 *
 * 这个文件存在的理由是：表情面板是最容易做成「一堆好看的方块、其实没接线」的地方。
 * 所以每条断言都找**可观测的证据**，而不是「数一数元素个数 > 0」：
 *   - 图片要 naturalWidth > 0 且 src 指到本地 /emoji/（证明素材真在、且没有外链）
 *   - 插入要看 textarea 里的**字符**，并验证连点两次不会倒着插
 *   - 大表情要落到**后端**：GET 消息里 kind=image + fileUrl 以 /emoji/ 开头
 *   - 贴纸形态要断言它不在 .bubble 里（只比大小是假断言）
 *   - 「最近使用」要跨页面刷新还在（只存 state 的实现在这里会挂）
 *
 * 跑法：node scripts/check-emoji.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL as NodeURL } from 'node:url'
import { purgeMessagesAfter, maxMessageId } from './lib/debris.mjs'
import { assertSafeAnimGif, DISPOSAL_NAME } from './lib/gif.mjs'
import { freePort, isAppTarget, foreignTarget, connectCdp } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const PORT = await freePort()
const OUT = 'D:/BS-chat-os/shots/emoji'
const PROFILE_DIR = 'D:/BS-chat-os/.tmp/chrome-emoji'
const PASS = 'chatly123'

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(PROFILE_DIR, { recursive: true })

const { EMOJI_TABS, EMOJI_BIG, EMOJI_ALL } = await import('../src/data/emoji.js')
const { EMOJI_ANIM } = await import('../src/data/emoji-anim.js')

/* 本轮会往演示会话里发好几条大表情（动画的、回退静态的），开跑前记基线，
   收尾按基线删 —— 只记住一条 id 的话，多发的就留在演示库里了。 */
const msgBaseline = maxMessageId()

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 后端准备 ================= */
const login = async (u) =>
  (
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: PASS }),
    })
  ).json()

const me = await login('chenmo')
const auth = { Authorization: `Bearer ${me.token}`, 'Content-Type': 'application/json' }
const convs = (await (await fetch(`${API}/conversations`, { headers: auth })).json()).conversations
const priv = convs.find((c) => c.type === 'private')
if (!priv) throw new Error('演示库里没有私聊会话')
console.log(`演示对象：我=${me.user.nickname} · 会话「${priv.name}」#${priv.id}\n`)

const lastMsg = async () => {
  const { messages } = await (
    await fetch(`${API}/conversations/${priv.id}/messages?limit=5`, { headers: auth })
  ).json()
  return messages[messages.length - 1]
}

/* ================= 0. 素材完整性 ================= */
console.log('─── 0. 素材完整性 ───')
let badSvg = 0
let missingFile = 0
for (const code of EMOJI_ALL) {
  const p = `D:/BS-chat-os/public/emoji/${code}.svg`
  if (!fs.existsSync(p)) {
    missingFile++
    continue
  }
  const s = fs.readFileSync(p, 'utf8')
  if (!s.startsWith('<svg') || !s.includes('viewBox') || s.length < 300) badSvg++
}
ok(missingFile === 0, `清单 ${EMOJI_ALL.length} 个码点都有对应素材文件`, `缺 ${missingFile}`)
ok(badSvg === 0, '素材都是有效 SVG（含 viewBox、体积正常）', `坏 ${badSvg}`)

const httpBad = []
for (const code of EMOJI_ALL.slice(0, 40)) {
  const r = await fetch(`${APP_HOST}/emoji/${code}.svg`)
  if (!r.ok || !(await r.text()).includes('<svg')) httpBad.push(code)
}
ok(httpBad.length === 0, '抽样 40 个素材经前端可访问且是 SVG', httpBad.join(' ') || '')

/* 表情素材必须带缓存头 —— 386 个静态 + 30 个动画都是**不变素材**，
   每次打开面板都重新请求纯属浪费。
   断言「有 max-age」而不是具体秒数：dev 和 preview 的策略不一样
   （见 vite.config.js 的 emojiCacheHeaders），写死秒数会变成一改配置就红的脆断言。 */
const noCache = []
for (const u of ['/emoji/1f602.svg', '/emoji-anim/1f602.gif']) {
  const r = await fetch(APP_HOST + u)
  const cc = r.headers.get('cache-control') || ''
  if (!/max-age=\d+/.test(cc)) noCache.push(`${u} → ${cc || '（无）'}`)
}
ok(noCache.length === 0, '表情素材带缓存头（看过一次后走本地副本，不重复请求）', noCache.join(' ') || '')

/* 动画大表情：上游给的是 APNG（2.8MB/个），本地转成了 **GIF**。
   三条必须验的，缺一条都会产出「看起来完全正常、其实坏了」的图：
     1. 真的是动画 —— ffmpeg 少传 -loop 或输入不是 APNG，会转出一张不会动的图
     2. 每帧 disposal=2 —— 这是本项目踩过的最狠的坑：WebP 版帧是 blend+dispose=none，
        透明背景的表情在浏览器里逐帧累积，肉眼看到「两个表情叠着」。
        只比对文件体积和后缀永远抓不到，必须把处置方式读出来断言。
     3. 有 NETSCAPE 循环扩展 —— 否则只播一遍就停住 */
const animCodes = Object.keys(EMOJI_ANIM)
let animMissing = 0
const animNotAnim = []
let animBytes = 0
for (const code of animCodes) {
  const p = `D:/BS-chat-os/public/emoji-anim/${code}.gif`
  if (!fs.existsSync(p)) {
    animMissing++
    continue
  }
  animBytes += fs.statSync(p).size
  try {
    assertSafeAnimGif(p)
  } catch (e) {
    animNotAnim.push(`${code}(${e.message})`)
  }
}
ok(animMissing === 0, `动画清单 ${animCodes.length} 个都有素材文件`, `缺 ${animMissing}`)
ok(
  animNotAnim.length === 0,
  '动画素材都是**能安全播放的** GIF（帧数够 / disposal=恢复背景 / 有循环）',
  animNotAnim.join(' ') || ''
)
/* 换过一次格式（WebP→GIF），旧产物必须清干净：
   public 里同时存在两套动画时，浏览器读到哪个都不对，而且很难发现。 */
const staleWebp = fs
  .readdirSync('D:/BS-chat-os/public/emoji-anim')
  .filter((f) => f.endsWith('.webp'))
ok(staleWebp.length === 0, '没有残留的旧版 .webp 动画产物', staleWebp.join(' ') || '')
ok(
  animCodes.length > 0 && animBytes / animCodes.length < 200 * 1024,
  '动画单个体积可控（< 200KB，移动端可用）',
  `平均 ${(animBytes / Math.max(animCodes.length, 1) / 1024).toFixed(0)}KB × ${animCodes.length} = ${(animBytes / 1048576).toFixed(2)}MB`
)

const animHttpBad = []
for (const code of animCodes.slice(0, 8)) {
  const r = await fetch(`${APP_HOST}/emoji-anim/${code}.gif`)
  if (!r.ok || r.headers.get('content-type') !== 'image/gif') animHttpBad.push(code)
}
ok(animHttpBad.length === 0, '抽样动画素材经前端可访问且 MIME 是 image/gif', animHttpBad.join(' ') || '')

/* ================= 极简 CDP ================= */
const jget = (p) =>
  new Promise((res, rej) =>
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  )

async function waitTarget() {
  let seen = null
  for (let i = 0; i < 80; i++) {
    try {
      const l = await jget('/json/list')
      /* ⚠️ 不能只看「有没有 page target」：端口被别人的浏览器占掉时（本机多项目并行很常见），
         拿到的会是别人的页面，后面 boot() 必然超时，报出「应用没挂载」这种误导性结论。
         必须校验 url 归属本应用。 */
      const p = (l || []).find((x) => isAppTarget(x, APP_HOST))
      if (p) return p
      seen = foreignTarget(l, APP_HOST) || seen
    } catch {}
    await sleep(250)
  }
  throw new Error(
    seen
      ? `调试端口 ${PORT} 被别的浏览器占用了（页面是 ${seen.url}）—— 不是应用的问题，换个端口或关掉那个实例`
      : 'chrome not ready'
  )
}

const proc = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--window-size=430,940',
    APP,
  ],
  { stdio: 'ignore' }
)

const t = await waitTarget()
const cdp = await connectCdp(t.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval')
  return r.result?.value
}
const waitFor = async (expr, ms = 12000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await js(expr)) return true
    } catch {}
    await sleep(150)
  }
  return false
}
const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
}

const HELPERS = `
window.__click = (s) => { const e=document.querySelector(s); if(!e) return false; e.click(); return true }
window.__has = (s) => !!document.querySelector(s)
window.__clickText = (sel, txt) => {
  const e=[...document.querySelectorAll(sel)].find(x=>x.textContent.trim()===txt)
  if(!e) return false; e.click(); return true
}
window.__cells = () => [...document.querySelectorAll('.ep-cell')].map(c => {
  const img = c.querySelector('img')
  return { src: (img && img.getAttribute('src')) || '', w: (img && img.naturalWidth) || 0, label: c.getAttribute('aria-label') || '' }
})
window.__tabs = () => [...document.querySelectorAll('.ep-tab')].map(b => ({
  t: b.textContent.trim(), on: b.classList.contains('is-on')
}))
window.__modes = () => [...document.querySelectorAll('.ep-seg-btn')].map(b => ({
  t: b.textContent.trim(), on: b.classList.contains('is-on')
}))
window.__ta = () => { const e=document.querySelector('.cp-field textarea'); return e ? e.value : null }
/* 当前焦点落在谁身上 —— 用来断言「收起面板后光标还在输入框里」，
   别用「输入框有 value」代替：value 一直在，跟焦点无关。 */
window.__active = () => {
  const e = document.activeElement
  if (!e) return 'none'
  const tag = String(e.tagName || '').toLowerCase()
  const cls = typeof e.className === 'string' && e.className.trim()
    ? '.' + e.className.trim().split(/\s+/)[0]
    : ''
  return tag + cls
}
window.__setCaret = (p) => {
  const e=document.querySelector('.cp-field textarea'); if(!e) return false
  e.focus(); e.setSelectionRange(p,p); return true
}
window.__setVal = (sel, v) => {
  const el = document.querySelector(sel); if (!el) return false
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true })); return true
}
window.__lastBubble = () => {
  const rows = [...document.querySelectorAll('.room-scroll .msg')]
  const r = rows[rows.length-1]
  if (!r) return null
  const st = r.querySelector('.sticker')
  const ib = r.querySelector('.img-bubble')
  const b  = r.querySelector('.bubble')
  return {
    kind: st ? 'sticker' : ib ? 'image' : b ? 'text' : 'none',
    inBubble: st ? !!st.closest('.bubble') : false,
    bg: st ? getComputedStyle(st).backgroundColor : null,
    src: (st && st.getAttribute('src')) || (ib && ib.querySelector('img') && ib.querySelector('img').getAttribute('src')) || null,
    nw: (st && st.naturalWidth) || (ib && ib.querySelector('img') && ib.querySelector('img').naturalWidth) || 0,
    alt: st ? st.getAttribute('alt') : null,
    w: st ? Math.round(st.getBoundingClientRect().width) : 0,
    h: st ? Math.round(st.getBoundingClientRect().height) : 0
  }
}
window.__recent = () => { try { return JSON.parse(localStorage.getItem('chatly.emoji.recent') || '[]') } catch (e) { return [] } }
window.__overflow = () => {
  const de = document.documentElement
  return { sw: de.scrollWidth, cw: de.clientWidth }
}
window.__roomH = () => {
  const r = document.querySelector('.room-scroll')
  return r ? Math.round(r.getBoundingClientRect().height) : 0
}
`

/* 从登录页进到私聊会话。
   ⚠️ 两种入口都要认：脚本中途会 Page.reload 验证 localStorage 持久化，
   那时 token 还在、应用直接进聊天列表而**不会**回登录页。
   只等登录页的话第二次 boot 必然超时。 */
async function boot() {
  await js(HELPERS)
  const ready = await waitFor(
    `!!document.querySelector('.lg-demo-list button') || !!document.querySelector('.chat-list .chat-row')`,
    15000
  )
  if (!ready) throw new Error('登录页和聊天列表都没出现 —— 应用可能没挂载')
  if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
    await js(
      `(() => { const b=[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨')); if(b) b.click(); return !!b })()`
    )
  }
  const listed = await waitFor(`!!document.querySelector('.chat-list .chat-row')`, 15000)
  if (!listed) throw new Error('聊天列表没出现 —— 登录没成功')
  const name = JSON.stringify(priv.name)
  await js(
    `(() => { const r=[...document.querySelectorAll('.chat-list .chat-row')].find(x=>((x.querySelector('.cr-name')||{}).textContent||'').includes(${name})); if(r) r.click(); return !!r })()`
  )
  const inRoom = await waitFor(`!!document.querySelector('.room-scroll')`, 15000)
  if (!inRoom) throw new Error('没进到会话页')
  await sleep(600)
  await js(HELPERS)
}

/* 发一次**真实**鼠标事件：浏览器会自己合成 pointerdown → mousedown → mouseup → click。
   为什么不能全用 `el.click()`：`.click()` 只派发 click 事件，不派发 pointerdown，
   而「点输入框收起面板」是挂在这两个事件上的 —— 只测 click 等于把 pointerdown 那条路留在盲区。
   （真机上 pointerdown 才是先到手的那个，也是手机上软键盘顶起布局后仍然可靠的那个。） */
async function realTap(sel) {
  const box = await js(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!box) throw new Error(`找不到可点的元素：${sel}`)
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  return box
}

const openPanel = async () => {
  await js(`window.__click('.composer .cp-btn[aria-label*="表情"]')`)
  const on = await waitFor(`!!document.querySelector('.ep')`, 6000)
  await sleep(500)
  await js(HELPERS)
  return on
}

/* 本轮发出去的那条大表情，收尾时从库里删掉 ——
   演示会话里不该每跑一次就多一条探针贴纸。
   （撤回不是办法：产品语义上撤回会留一行「消息已撤回」，一样是痕迹。） */

try {
  /* ===================== 准备 ===================== */
  await waitFor(`!!document.querySelector('body')`)
  try {
    await cdp.send('Runtime.evaluate', { expression: 'localStorage.clear()' })
  } catch {}
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1500)
  await boot()

  /* Chrome 的 --user-data-dir 是复用的，上一轮写进 localStorage 的「最近使用」会留到这一轮，
     导致分类数从 9 变 10、A 段断言随机假红。这里显式清零再重载一次，保证起点确定。
     （教训：凡是依赖 localStorage 的断言，都要先把它清成已知状态。） */
  await cdp.send('Runtime.evaluate', { expression: `localStorage.removeItem('chatly.emoji.recent')` })
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1500)
  await boot()

  /* ===================== A. 面板打开与素材加载 ===================== */
  console.log('─── A. 面板打开与素材加载 ───')
  const opened = await openPanel()
  ok(opened, '点表情按钮后面板出现')
  await shot('01-panel')

  const modes = await js(`window.__modes()`)
  ok(modes.length === 2 && modes[0].on, '默认停在「表情」档', JSON.stringify(modes))

  // 分类数 = 分组数 + 「最近」这一项（有记录才出现）——写成相对值，
  // 免得以后清不干净 localStorage 就变成随机假红。
  const recentNow = await js(`window.__recent()`)
  const tabs = await js(`window.__tabs()`)
  const expectTabs = EMOJI_TABS.length + (recentNow.length ? 1 : 0)
  ok(tabs.length === expectTabs, `分类数 = 分组数 ${EMOJI_TABS.length} + 最近 ${recentNow.length ? 1 : 0}`, `实际 ${tabs.length}`)
  const firstTab = tabs.find((t) => t.t === '笑脸')
  ok(firstTab && firstTab.on === true, '默认选中「笑脸」分类', JSON.stringify(tabs[0]))

  const cells = await js(`window.__cells()`)
  ok(cells.length > 0, '网格渲染出表情', `${cells.length} 个`)
  const loaded = cells.filter((c) => c.w > 0)
  ok(loaded.length > 0, '图片真的解码出像素（naturalWidth > 0）', `${loaded.length}/${cells.length}`)
  const offsite = cells.filter((c) => !c.src.startsWith('/emoji/'))
  ok(offsite.length === 0, '所有素材都指到本地 /emoji/（零外链）', offsite.map((c) => c.src).join(' ') || '')
  ok(
    cells.every((c) => c.label && c.label.length > 0),
    '每个表情都有可读名称（aria-label）'
  )

  /* ===================== B. 分类切换 ===================== */
  console.log('\n─── B. 分类切换 ───')
  const before = (await js(`window.__cells()`))[0].src
  await js(`window.__clickText('.ep-tab','动物')`)
  await sleep(500)
  await js(HELPERS)
  const animals = await js(`window.__cells()`)
  const animalTab = (await js(`window.__tabs()`)).find((x) => x.t === '动物')
  ok(animalTab && animalTab.on === true, '点「动物」后该分类变为选中')
  ok(
    animals[0] && animals[0].src === '/emoji/1f436.svg',
    '动物组第一个是狗（不是按码点排序得到的冷门鼠类）',
    (animals[0] && animals[0].src) || ''
  )
  ok(animals[0] && animals[0].src !== before, '切换分类后网格内容真的变了')

  await js(`window.__clickText('.ep-tab','笑脸')`)
  await sleep(400)
  await js(HELPERS)
  const smileys = await js(`window.__cells()`)
  ok(
    smileys[0] && smileys[0].src === '/emoji/1f602.svg',
    '切回笑脸组第一个是「笑哭」',
    (smileys[0] && smileys[0].src) || ''
  )

  /* ===================== C. 插入到输入框光标处 ===================== */
  console.log('\n─── C. 插入输入框 ───')
  await js(`window.__setVal('.cp-field textarea','')`)
  await sleep(250)
  await js(HELPERS)
  await js(`document.querySelector('.ep-cell').click()`)
  await sleep(400)
  await js(HELPERS)
  const one = await js(`window.__ta()`)
  ok(!!one && one.length >= 1, '点表情后输入框出现字符', JSON.stringify(one))
  ok(/[^\s]/.test(one || ''), '插入的是真实 Unicode 字符（非空串）')

  // 连点两次不能倒着插：第二次必须追加在第一次之后
  await js(`document.querySelectorAll('.ep-cell')[1].click()`)
  await sleep(400)
  await js(HELPERS)
  const two = await js(`window.__ta()`)
  ok(
    !!two && !!one && two.indexOf(one) === 0 && two.length > one.length,
    '连点两次是顺序追加（不会倒着插）',
    JSON.stringify(two)
  )

  // 光标挪到开头再插：旧内容必须被整体顶到后面。
  // 断言写成「相对基线」而不是拼出预期字符串 —— 面板顺序一变，写死预期就会假红。
  await js(`window.__setCaret(0)`)
  await sleep(200)
  await js(`document.querySelectorAll('.ep-cell')[2].click()`)
  await sleep(400)
  await js(HELPERS)
  const three = await js(`window.__ta()`)
  ok(
    !!three && !!two && three.length > two.length && three.slice(-two.length) === two,
    '光标在开头时插入的字符落在最前面',
    JSON.stringify(three)
  )

  /* ===================== D. 最近使用 ===================== */
  console.log('\n─── D. 最近使用 ───')
  const recent = await js(`window.__recent()`)
  ok(recent.length >= 3, '最近使用已记录', JSON.stringify(recent.slice(0, 3)))
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1800)
  await boot()
  await openPanel()
  const tabs2 = await js(`window.__tabs()`)
  ok(tabs2[0] && tabs2[0].t === '最近', '刷新后「最近」分类仍在且排第一', JSON.stringify(tabs2.slice(0, 2)))
  // 必须先切到「最近」再数格子 —— 面板默认是第一个分类，
  // 不切就数到的是笑脸组，3 条最近记录和 48 个格子都能「通过」，典型的假绿。
  await js(`window.__clickText('.ep-tab','最近')`)
  await sleep(450)
  await js(HELPERS)
  const recentCells = await js(`window.__cells()`)
  ok(
    recentCells.length === recent.length,
    `「最近」里的数量 = 记录条数 ${recent.length}`,
    `实际 ${recentCells.length}`
  )
  ok(
    recentCells[0] && recentCells[0].src === `/emoji/${recent[0]}.svg`,
    '「最近」第一个就是最近用过的那个',
    (recentCells[0] && recentCells[0].src) || ''
  )
  await shot('02-recent')

  /* ===================== E. 大表情：点一下直接发 ===================== */
  console.log('\n─── E. 大表情直发 ───')
  await js(`window.__clickText('.ep-seg-btn','大表情')`)
  await sleep(500)
  await js(HELPERS)
  const modes2 = await js(`window.__modes()`)
  ok(modes2[1] && modes2[1].on === true, '切到「大表情」档', JSON.stringify(modes2))
  ok(await js(`window.__has('.ep-grid.is-big')`), '大表情用的是大网格')
  const bigCells = await js(`window.__cells()`)
  ok(
    bigCells.length === EMOJI_BIG.length,
    `大表情数量 = 清单 ${EMOJI_BIG.length}`,
    `实际 ${bigCells.length}`
  )
  // ⚠️ 括号不能省：`a && b === c || d` 会被解析成 `(a && b===c) || d`，
  // 后半段是个非空字符串、恒为真 —— 断言就变成永远通过的假绿。
  const expectFirst = EMOJI_ANIM[EMOJI_BIG[0]] || `/emoji/${EMOJI_BIG[0]}.svg`
  ok(
    bigCells[0] && bigCells[0].src === expectFirst,
    '大表情第一个取自 EMOJI_BIG（不是当前分类的大图）',
    `实际 ${(bigCells[0] && bigCells[0].src) || ''} 期望 ${expectFirst}`
  )
  await shot('03-big')

  const beforeMsg = await lastMsg()
  await js(`document.querySelector('.ep-cell.is-big').click()`)
  await sleep(1600)
  await js(HELPERS)
  const afterMsg = await lastMsg()
  ok(afterMsg.id !== beforeMsg.id, '发出了一条新消息', `#${afterMsg.id}`)
  ok(afterMsg.kind === 'image', '后端记录的是 image 类型', afterMsg.kind)
  ok(
    /^\/emoji(-anim)?\//.test(String(afterMsg.fileUrl || '')),
    '消息 fileUrl 指到本地 /emoji/ 或 /emoji-anim/（零外链）',
    afterMsg.fileUrl || ''
  )
  ok(!!afterMsg.fileName, 'fileName 带上了表情名（无障碍用）', afterMsg.fileName || '')

  const bubble = await js(`window.__lastBubble()`)
  ok(bubble && bubble.kind === 'sticker', '界面上渲染成贴纸形态', JSON.stringify(bubble))
  ok(bubble && bubble.inBubble === false, '贴纸不在气泡里（这是它和普通图片消息的区别）')
  ok(
    bubble && (bubble.bg === 'rgba(0, 0, 0, 0)' || bubble.bg === 'transparent'),
    '贴纸没有背景色',
    (bubble && bubble.bg) || ''
  )
  ok(bubble && bubble.nw > 0, '贴纸图片真的解码出像素', String(bubble && bubble.nw))
  ok(
    bubble && bubble.w >= 80 && bubble.w === bubble.h,
    '贴纸尺寸够大且是正方形',
    `${bubble && bubble.w}×${bubble && bubble.h}`
  )
  await shot('04-sticker')

  /* ===================== G. 动画大表情 + 静态回退 ===================== */
  console.log('\n─── G. 动画大表情与静态回退 ───')

  /* 上游只给一部分大表情做了动画（手势类基本没有），所以这一档必然是**混合**的：
     有动画的会动、没有的静止。两段都要断言 —— 只测动画会漏掉 17 个回退的表情，
     只测静态则动画白做。 */
  const animCells = bigCells.filter((c) => c.src.startsWith('/emoji-anim/'))
  const staticCells = bigCells.filter(
    (c) => c.src.startsWith('/emoji/') && !c.src.startsWith('/emoji-anim/')
  )
  ok(
    animCells.length === animCodes.length,
    `面板里动画大表情 ${animCodes.length} 个`,
    `实际 ${animCells.length}`
  )
  ok(
    animCells.every((c) => c.src.endsWith('.gif')),
    '动画格子都指向 .gif',
    animCells.filter((c) => !c.src.endsWith('.gif')).map((c) => c.src).join(' ') || ''
  )
  ok(
    staticCells.length === EMOJI_BIG.length - animCodes.length,
    `其余 ${EMOJI_BIG.length - animCodes.length} 个回退静态 SVG`,
    `实际 ${staticCells.length}`
  )

  /* 这条是动画接入最容易踩的坑：`isEmojiSticker()` 原先只判 `/emoji/` 前缀，
     而 `'/emoji-anim/1f602.gif'.startsWith('/emoji/')` 是 **false** ——
     动画贴纸会掉进「普通图片消息」分支，带上气泡边框发出去，一眼就是 bug。 */
  ok(
    afterMsg.fileUrl === expectFirst,
    '发出的是清单里那个地址（有动画就用动画）',
    `${afterMsg.fileUrl} / 期望 ${expectFirst}`
  )
  ok(
    expectFirst.startsWith('/emoji-anim/') && bubble && bubble.kind === 'sticker',
    '★ 动画贴纸渲染成贴纸形态（isEmojiSticker 必须认 /emoji-anim/ 前缀）',
    `src=${(bubble && bubble.src) || ''} kind=${(bubble && bubble.kind) || ''}`
  )
  ok(bubble && bubble.nw > 0, '动画贴纸解码出像素', String(bubble && bubble.nw))

  /* ⚠️ 这里**刻意不做**「把 GIF 画进 canvas 采样多帧」的运行时断言。
     试过，是个假断言：headless Chrome 的 drawImage 对动画图只给第一帧，
     setTimeout 和 requestAnimationFrame 都等不到帧推进，采出来是一串常数
     （0.6417 × 18）。于是「序列有界 = 没有叠影」永远通过，「真的在动」永远失败 ——
     两条都是噪声，不是证据。
     「不叠影」的真正判据在上面的文件级断言（每帧 disposal=恢复背景 + 有循环扩展）：
     那是确定性的，而且用一个独立解码器交叉验证过 ——
     把同一个表情的 disposal 改成「不处置」后，规范播放到最后一帧的
     不透明面积 0.621 → 0.678、包围盒 100x102 → 106x107（超出任何单帧），
     残影立刻现形。改格式 / 改转码参数后重跑上面那两条就够。 */

  /* 回退路径：点一个上游没做动画的大表情（比如 👍），
     发出去的是静态 SVG，但**形态仍然是贴纸** —— 不能因为没动画就变成带气泡的图片。 */
  const noAnimCode = EMOJI_BIG.find((c) => !EMOJI_ANIM[c])
  const noAnimIdx = EMOJI_BIG.indexOf(noAnimCode)
  if (!(await js(`window.__has('.ep')`))) await openPanel()
  await js(`window.__clickText('.ep-seg-btn','大表情')`)
  await sleep(400)
  await js(HELPERS)
  await js(`document.querySelectorAll('.ep-cell.is-big')[${noAnimIdx}].click()`)
  await sleep(1600)
  await js(HELPERS)
  const m2 = await lastMsg()
  ok(
    m2.fileUrl === `/emoji/${noAnimCode}.svg`,
    `★ 没有动画版的大表情（${noAnimCode}）回退静态 SVG`,
    String(m2.fileUrl)
  )
  const b2 = await js(`window.__lastBubble()`)
  ok(
    b2 && b2.kind === 'sticker',
    '★ 回退静态的也仍是贴纸形态（不能退化成普通图片消息）',
    JSON.stringify(b2)
  )
  ok(b2 && b2.nw > 0, '回退的静态图解码成功', String(b2 && b2.nw))
  await shot('05-anim-vs-static')

  /* ===================== F. 布局与回归 ===================== */
  console.log('\n─── F. 布局与回归 ───')
  const ov = await js(`window.__overflow()`)
  ok(ov.sw <= ov.cw + 1, '面板打开时没有横向溢出', `scrollWidth ${ov.sw} / clientWidth ${ov.cw}`)

  // 这条是修掉的缺陷：以前「有输入就只剩发送按钮」，打字时点不到表情
  await js(`window.__setVal('.cp-field textarea','正在打字')`)
  await sleep(450)
  await js(HELPERS)
  const still = await js(
    `!!document.querySelector('.composer .cp-btn[aria-label*="表情"]') && !!document.querySelector('.cp-send')`
  )
  ok(still, '打字时表情按钮仍在（发送与表情共存）')

  const roomH = await js(`window.__roomH()`)
  ok(roomH > 120, '面板打开后消息区仍有可用高度', `${roomH}px`)

  await js(`window.__click('.room-scroll')`)
  await sleep(450)
  ok(!(await js(`window.__has('.ep')`)), '点消息区收起面板')

  await openPanel()
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  })
  await sleep(450)
  ok(!(await js(`window.__has('.ep')`)), 'Esc 收起面板')

  /* ===== 点输入框收起面板 =====
     用户要求：面板开着时想打字，直接点输入框就该收起，不该还得再点一次表情按钮。 */
  await openPanel()
  await shot('06-before-input-tap')
  await realTap('.cp-field') // 真实鼠标事件：同时走 pointerdown 与 click
  await sleep(450)
  await shot('07-after-input-tap')
  ok(!(await js(`window.__has('.ep')`)), '点输入框收起面板（真实鼠标事件）')
  const act = await js(`window.__active()`)
  ok(act === 'textarea', '收起面板后焦点落在输入框（可以立刻打字）', act)

  /* ★ 反向断言：挑表情**不能**把面板关掉。
     这两条是一体两面 —— 实现「点输入框收起」最省事的写法是把逻辑挂在 focus 上，
     但 `insert()` 挑完表情会 `el.focus()` 把光标放回输入框，
     只要那一刻 textarea 是**失焦**的，就会触发一次 focus 事件，面板被自己关掉，
     根本没法连续挑。只测正向会漏掉这个退化，必须把反向也钉住。

     ⚠️ 这里必须用 realTap 打开面板，不能用 `el.click()`：
     `el.click()` 不会移动焦点，textarea 一直保持聚焦，
     于是 insert() 里的 `el.focus()` 是个空操作、不产生 focus 事件 ——
     反例就没有鉴别力了（把实现改成 focus 驱动也能蒙混过关）。
     真实点击会把焦点移到表情按钮上，textarea 真的失焦，反例才咬得住。 */
  await realTap('.composer .cp-btn[aria-label*="表情"]')
  await sleep(550)
  ok(await js(`window.__has('.ep')`), '再点「表情」按钮可重新打开面板（状态已复位）')
  const preFocus = await js(`window.__active()`)
  ok(preFocus !== 'textarea', '（前置条件）面板打开后焦点不在输入框 —— 反例才有鉴别力', preFocus)

  await js(`window.__clickText('.ep-seg-btn','表情')`)
  await sleep(400)
  const taBefore = (await js(`window.__ta()`)) || ''
  await js(`document.querySelector('.ep-cell').click()`)
  await sleep(500)
  ok(await js(`window.__has('.ep')`), '★ 挑表情后面板仍然打开（能连续挑）')
  const taAfter = (await js(`window.__ta()`)) || ''
  /* ⚠️ 要按**码点**数，不能用 String.length：emoji 在 UTF-16 里是代理对，
     `'😂'.length === 2`。用 .length 会算出 +2，误判成「插了两次」。
     （同一类坑在 C 段「连点两次顺序追加」那里也是这么处理的。） */
  const cps = (s) => [...s].length
  ok(
    cps(taAfter) === cps(taBefore) + 1,
    '★ 挑的表情真的插进了输入框（只插一次）',
    `${cps(taBefore)} → ${cps(taAfter)} 码点`
  )

  // 收尾把面板关掉：后面没有依赖它的断言了，但留着会让脚本结束时状态不干净
  await js(`window.__click('.composer .cp-btn[aria-label*="表情"]')`)
  await sleep(400)

  console.log(`\n${failures === 0 ? '🎉 全部通过' : `❌ ${failures} 条失败`}`)
} catch (e) {
  console.error('\n💥 脚本异常:', e.message)
  failures++
} finally {
  try {
    await shot('99-final')
  } catch {}
  try {
    cdp.close()
  } catch {}
  proc.kill()
  // 按基线删：本轮发了动画贴纸 + 静态回退贴纸两条，只记住一个 id 会漏
  const gone = purgeMessagesAfter(msgBaseline)
  if (gone) console.log(`已清理自检发出的 ${gone} 条大表情消息`)
  process.exit(failures ? 1 : 0)
}
