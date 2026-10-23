/**
 * 全屏 UI 缺陷审计
 * 检测：横向溢出 / 元素越界 / 文本截断 / 点击目标过小 / 元素重叠 / 空容器
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { URL as NodeURL } from 'node:url'
import { purgeMessagesAfter, maxMessageId, purgeOrphanUploads } from './lib/debris.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

/* 这个脚本是「遍历所有界面并点开能点的一切」—— 包括表情面板的大表情格子，
   点下去就是真发一条消息。所以它会往演示库里留东西（实测一轮留下一条
   `/emoji-anim/1f602.webp` 贴纸）。开跑前记基线，收尾按基线删。 */
const msgBaseline = await maxMessageId()

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9420

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/BS-chat-os/.tmp/chrome-audit',
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=900,1000',
  'http://127.0.0.1:5198/',
], { stdio: 'ignore' })

const jget = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)))
  }).on('error', rej)
})
async function waitTarget() {
  for (let i = 0; i < 60; i++) {
    try { const l = await jget('/json/list'); const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (p) return p } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('timeout')
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(wsUrl)
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64') },
    })
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true)
      let buf = Buffer.alloc(0); const waiters = new Map(); let id = 0
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) break
          const op = buf[0] & 0x0f
          let len = buf[1] & 0x7f, off = 2
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
          if (buf.length < off + len) break
          const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len)
          if (op === 0x8) { socket.end(); break }
          try {
            const m = JSON.parse(payload.toString('utf8'))
            if (m.id && waiters.has(m.id)) {
              const w = waiters.get(m.id); waiters.delete(m.id)
              m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result)
            }
          } catch {}
        }
      })
      const send = (method, params = {}) => {
        const mid = ++id
        const data = Buffer.from(JSON.stringify({ id: mid, method, params }))
        const mask = Buffer.from([1, 2, 3, 4])
        let h
        if (data.length < 126) { h = Buffer.alloc(6); h[0] = 0x81; h[1] = 0x80 | data.length; mask.copy(h, 2) }
        else if (data.length < 65536) { h = Buffer.alloc(8); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(data.length, 2); mask.copy(h, 4) }
        else { h = Buffer.alloc(14); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(data.length), 2); mask.copy(h, 10) }
        const mk = Buffer.alloc(data.length)
        for (let i = 0; i < data.length; i++) mk[i] = data[i] ^ mask[i % 4]
        socket.write(Buffer.concat([h, mk]))
        return new Promise((rs, rj) => waiters.set(mid, { resolve: rs, reject: rj }))
      }
      resolve({ send, close: () => socket.end() })
    })
    req.on('error', reject); req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t = await waitTarget()
const cdp = await connect(t.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
const ev = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
const clickText = (txt, sel = 'button') => ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim()===${JSON.stringify(txt)})||[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(txt)}));if(!e)return false;e.click();return true})()`)

/* ---------- 审计逻辑 ---------- */
const AUDIT = `(() => {
  const vw = window.innerWidth
  const name = (el) => {
    if (el.id) return '#' + el.id
    let s = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : el.tagName.toLowerCase()
    return s
  }
  const out = { overflowX: [], outOfBounds: [], clippedText: [], smallTap: [], zeroSize: [] }

  // 1. 横向溢出：元素右边界超出视口
  for (const el of document.querySelectorAll('.phone *')) {
    const b = el.getBoundingClientRect()
    if (b.width === 0 || b.height === 0) continue
    // 允许横向滚动容器内部
    let p = el, scrollable = false
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') { scrollable = true; break }
      p = p.parentElement
    }
    if (scrollable) continue
    if (b.right > vw + 1 || b.left < -1) out.outOfBounds.push({ el: name(el), left: Math.round(b.left), right: Math.round(b.right) })
  }

  // 2. 文本被容器裁掉（内容溢出且没有 ellipsis / clamp）
  for (const el of document.querySelectorAll('.phone *')) {
    if (!el.children.length && el.textContent.trim()) {
      const cs = getComputedStyle(el)
      if (cs.overflow === 'hidden' && cs.textOverflow !== 'ellipsis' && cs.webkitLineClamp === 'none') {
        if (el.scrollWidth > el.clientWidth + 2) out.clippedText.push({ el: name(el), text: el.textContent.trim().slice(0, 18), scrollW: el.scrollWidth, clientW: el.clientWidth })
      }
    }
  }

  // 3. 点击目标过小（<32px）
  //
  // 这里量的是「有效命中区」而不是元素自身的 box。
  // 原因：视觉尺寸和可点尺寸经常刻意不一致 —— 28px 高的开关、15px 高的已读回执，
  // 都是靠一个透明的 ::after 把命中区撑到 32px（见 ui.css「最小点击区补齐」）。
  // 只看 getBoundingClientRect 的审计会把这些改进全部误报成缺陷。
  // 所以改成从元素中心向上下逐像素探测，用 elementFromPoint 量出真正连成一片的命中范围。
  const hitAt = (el, x, y) => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
    const h = document.elementFromPoint(x, y)
    return !!h && (h === el || el.contains(h) || h.contains(el))
  }
  for (const el of document.querySelectorAll('.phone button, .phone input, .phone textarea')) {
    const b = el.getBoundingClientRect()
    if (b.width === 0 || b.height === 0) continue
    if (b.height >= 32 && b.width >= 32) continue

    const cx = Math.round(b.left + b.width / 2)
    const cy = Math.round(b.top + b.height / 2)
    // 中心点不在视口里就没法探测（elementFromPoint 会返回 null，
    // 那不代表「点不到」，只代表「现在看不到」—— 滚动列表里滚出屏幕的元素属于这类）
    if (cx < 0 || cy < 0 || cx >= vw || cy >= window.innerHeight) continue

    let up = 0
    while (up < 24 && hitAt(el, cx, cy - up - 1)) up++
    let down = 0
    while (down < 24 && hitAt(el, cx, cy + down + 1)) down++
    let left = 0
    while (left < 24 && hitAt(el, cx - left - 1, cy)) left++
    let right = 0
    while (right < 24 && hitAt(el, cx + right + 1, cy)) right++
    const hitH = up + down + 1
    const hitW = left + right + 1

    if (hitH >= 32 && hitW >= 32) continue
    out.smallTap.push({
      el: name(el),
      box: Math.round(b.width) + '×' + Math.round(b.height),
      hit: hitW + '×' + hitH,
      text: (el.textContent || '').trim().slice(0, 12),
    })
  }

  // 4. 文档级横向滚动
  const de = document.documentElement
  if (de.scrollWidth > vw) out.overflowX.push({ docScrollW: de.scrollWidth, vw })

  return out
})()`

async function audit(label) {
  // 守卫：应用未挂载时静默通过会掩盖真实问题
  const mounted = await ev(`!!document.querySelector('.phone') && document.querySelector('.phone').children.length > 0`)
  if (!mounted) {
    console.log(`❌ ${label} —— 应用未挂载（.phone 不存在），后续结果不可信`)
    return null
  }
  const r = await ev(AUDIT)
  const issues = []
  if (r.overflowX.length) issues.push(`横向滚动 scrollW=${r.overflowX[0].docScrollW} > ${r.overflowX[0].vw}`)
  if (r.outOfBounds.length) issues.push(`越界 ${r.outOfBounds.length}: ` + r.outOfBounds.slice(0, 4).map((x) => `${x.el}(${x.left}~${x.right})`).join(', '))
  if (r.clippedText.length) issues.push(`文本截断 ${r.clippedText.length}: ` + r.clippedText.slice(0, 4).map((x) => `"${x.text}"`).join(', '))
  if (r.smallTap.length) issues.push(`小点击目标 ${r.smallTap.length}: ` + r.smallTap.slice(0, 5).map((x) => `${x.el} box${x.box} 命中${x.hit}`).join(', '))

  if (issues.length === 0) console.log(`✅ ${label}`)
  else {
    console.log(`⚠️  ${label}`)
    issues.forEach((i) => console.log('     - ' + i))
  }
  return r
}

/* ---------- 先真正登录 ----------
   这一步以前是缺的：脚本直接对着「登录页」做完了整轮审计，
   报出来的「小点击目标 input(255×21)×2」就是登录框的两个输入框 ——
   看起来有输出，其实一个页面都没查到。 */
const waitFor = async (expr, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await ev(expr)) return true } catch {}
    await sleep(150)
  }
  return false
}
const bail = async (msg) => {
  console.log(`❌ ${msg}`)
  cdp.close(); chrome.kill()
  process.exit(1)
}
try {
  await ensureLoggedIn(ev)
} catch (e) {
  await bail('登录失败，无法审计：' + e.message)
}
if (!(await waitFor(`!!document.querySelector('.chat-list .chat-row')`))) await bail('登录失败，无法审计')
await sleep(600)

console.log('\n══════ 全屏 UI 审计（390×844） ══════\n')
console.log('  已登录（陈墨），开始逐屏审计\n')

console.log('【Tab 1 聊天】')
await audit('聊天列表')
const openRoom = await ev(`(()=>{const r=document.querySelector('.chat-row'); if(!r) return 'no-chat-row'; r.click(); return 'clicked'})()`)
await sleep(1200)
const roomState = await ev(`(()=>({hasRoom: !!document.querySelector('.room'), hasBack: !!document.querySelector('.rh-back'), bodyLen: document.querySelector('.phone').innerHTML.length}))()`)
console.log('     openRoom:', openRoom, JSON.stringify(roomState))
if (roomState.hasRoom) await audit('私聊会话')
await ev(`document.querySelector('.rh-back')?.click()`); await sleep(700)

console.log('\n【Tab 2 动态】')
await clickText('动态', '.tab'); await sleep(800)
await audit('动态列表')
await ev(`[...document.querySelectorAll('.mc-act')].find(b=>b.textContent.includes('评论'))?.click()`); await sleep(600)
await audit('动态-展开评论')

console.log('\n【Tab 3 发现】')
await clickText('发现', '.tab'); await sleep(800)
await audit('发现-推荐')
await clickText('附近'); await sleep(700); await audit('发现-附近')
await clickText('活动'); await sleep(700); await audit('发现-活动')
await clickText('用户'); await sleep(700); await audit('发现-用户')

console.log('\n【Tab 4 我】')
await clickText('我', '.tab'); await sleep(900)
await audit('我-个人空间')
for (const p of ['动态', '收藏', '稍后看', '最近文件']) {
  const ok = await clickText(p, '.quick-item'); await sleep(700)
  if (ok) { await audit(`我-${p}`); await ev(`document.querySelector('.sub-back').click()`); await sleep(500) }
}
for (const p of ['账号与安全', '隐私设置', '消息通知', '主题外观']) {
  const ok = await clickText(p, '.row'); await sleep(700)
  if (ok) { await audit(`我-${p}`); await ev(`document.querySelector('.sub-back').click()`); await sleep(500) }
}

console.log('\n【覆盖层】')
await clickText('聊天', '.tab'); await sleep(900)
/* 打开搜索面板。这里曾经是裸 .click()，一旦上一步没切回聊天列表就整个脚本崩掉，
   留个可读的诊断信息比一个 TypeError 有用得多。 */
const openedSearch = await ev(`(()=>{const b=document.querySelector('.chat-head-act .icon-btn');if(!b)return false;b.click();return true})()`)
if (!openedSearch) {
  const state = await ev(`JSON.stringify({
    tabs: [...document.querySelectorAll('.tabbar .tab')].map(t=>t.textContent.trim()),
    hasChatHead: !!document.querySelector('.chat-head'),
    hasSubPage: !!document.querySelector('.subpage'),
    hasMe: !!document.querySelector('.me-idcard'),
  })`)
  console.log(`  ⚠️ 没能切回聊天列表，跳过覆盖层审计：${state}`)
  cdp.close(); chrome.kill()
  process.exit(1)
}
await sleep(700)
await audit('搜索面板')
/* 走原生 setter + input 事件，否则 React 收不到 onChange，搜出来的还是空列表 */
await ev(`(()=>{const i=document.querySelector('.sp-field input');if(!i)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'林');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`); await sleep(900)
await audit('搜索结果')
await ev(`document.querySelector('.sub-back').click()`); await sleep(500)

cdp.close(); chrome.kill()
const gone = await purgeMessagesAfter(msgBaseline)
await purgeOrphanUploads({ quiet: false })
if (gone) console.log(`已清理审计过程中发出的 ${gone} 条消息`)
console.log('\n✅ 审计完成')
process.exit(0)
