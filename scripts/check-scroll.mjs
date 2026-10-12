/**
 * 长会话可滚动性 / 短会话贴底 —— 几何回归
 *
 * 为什么单独有这个脚本：
 *   `.room-scroll` 一度用 `justify-content: flex-end` + `overflow-y: auto`。
 *   Chrome 不会把「溢出到主轴起点」的那些项算进 scrollHeight ——
 *   实测 36 条消息的会话里 scrollHeight 仍报 712（= clientHeight），最大 scrollTop 恒为 0，
 *   于是 2363px 的历史消息被裁在滚动区上方且永远滚不到。
 *   现象极其隐蔽：截图看着完全正常（底部几条没错位），
 *   只有去读 scrollHeight / scrollTop 才看得出来 —— 所以必须用几何断言钉住。
 *
 * 断言两组：
 *   A. 找一个超过一屏的会话 → scrollHeight 必须 > clientHeight；
 *      滚到顶后首条元素必须完整可见（top == 滚动区顶 + padding，裁掉 0px）；
 *      scrollTop 能往返（0 ↔ max）。
 *   B. 找一个不足一屏的会话 → 内容仍要贴住输入区（设计意图不能丢），
 *      且绝不能出现「内容被推到滚动区上方」。
 *
 *   node scripts/check-scroll.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL as NodeURL } from 'node:url'
import { purgeDebris } from './lib/debris.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:3002/api/v1'
const APP = 'http://127.0.0.1:5198/'
const PORT = 9471
const OUT = 'D:/BS-chat-os/shots/scroll'
const PASS = 'chatly123'

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(path.join('D:/BS-chat-os/.tmp/chrome-scroll'), { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 先在后端挑出「最长」和「最短」的会话 ---------- */
const login = async (u) =>
  (await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: PASS }),
  })).json()

const me = await login('chenmo')
const auth = { Authorization: `Bearer ${me.token}`, 'Content-Type': 'application/json' }
const users = (await (await fetch(`${API}/users`, { headers: auth })).json()).users

const countConvs = async () => {
  const convs = (await (await fetch(`${API}/conversations`, { headers: auth })).json()).conversations
  const counted = []
  for (const c of convs) {
    const j = await (await fetch(`${API}/conversations/${c.id}/messages`, { headers: auth })).json()
    counted.push({ id: c.id, name: c.name, n: (j.messages || []).length })
  }
  counted.sort((a, b) => b.n - a.n)
  return counted
}

/* ---------- 自己造一条够长的会话 ----------
   以前这个脚本是「从库里挑最长的那条」——靠的是历次自检攒下来的 49 条消息。
   演示库一旦重置回种子状态（最长才 7 条），分页那段就**一条断言都测不到**了，
   而且不报错：`while` 翻页循环直接一次都不进。
   所以现在改成不够长就自己造，测完删 —— 自检脚本不该依赖别人留下的数据。 */
const LONG_ENOUGH = 45 // 每页 40 条，必须越过一页才测得到分页
let seeded = false
let counted = await countConvs()
if ((counted[0]?.n || 0) < LONG_ENOUGH) {
  const mate = users.find((u) => u.username === 'linxiaoxia')
  const r = await fetch(`${API}/conversations`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ type: 'group', title: '自检·长会话', memberIds: [mate.id] }),
  })
  const { conversationId } = await r.json()
  for (let i = 1; i <= 52; i++) {
    await fetch(`${API}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        conversationId,
        kind: 'text',
        text: `自检长会话第 ${i} 条 —— 用来验证滚动与分页`,
      }),
    })
  }
  seeded = true
  counted = await countConvs()
  console.log(`已造「自检·长会话」#${conversationId}：52 条消息`)
}

const longest = counted[0]
const shortest = counted[counted.length - 1]
console.log(`会话光谱：最长「${longest.name}」${longest.n} 条 · 最短「${shortest.name}」${shortest.n} 条`)

/* ---------- CDP ---------- */
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

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(wsUrl)
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64'),
      },
    })
    req.on('upgrade', (_r, socket) => {
      socket.setNoDelay(true)
      socket.on('error', () => {})
      let buf = Buffer.alloc(0)
      const waiters = new Map()
      let id = 0
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) break
          const op = buf[0] & 0x0f
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) {
            if (buf.length < 4) break
            len = buf.readUInt16BE(2)
            off = 4
          } else if (len === 127) {
            if (buf.length < 10) break
            len = Number(buf.readBigUInt64BE(2))
            off = 10
          }
          if (buf.length < off + len) break
          const payload = buf.subarray(off, off + len)
          buf = buf.subarray(off + len)
          if (op === 0x8) {
            socket.end()
            break
          }
          try {
            const m = JSON.parse(payload.toString('utf8'))
            if (m.id && waiters.has(m.id)) {
              const w = waiters.get(m.id)
              waiters.delete(m.id)
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
        if (data.length < 126) {
          h = Buffer.alloc(6)
          h[0] = 0x81
          h[1] = 0x80 | data.length
          mask.copy(h, 2)
        } else if (data.length < 65536) {
          h = Buffer.alloc(8)
          h[0] = 0x81
          h[1] = 0x80 | 126
          h.writeUInt16BE(data.length, 2)
          mask.copy(h, 4)
        } else {
          h = Buffer.alloc(14)
          h[0] = 0x81
          h[1] = 0x80 | 127
          h.writeBigUInt64BE(BigInt(data.length), 2)
          mask.copy(h, 10)
        }
        const mk = Buffer.alloc(data.length)
        for (let i = 0; i < data.length; i++) mk[i] = data[i] ^ mask[i % 4]
        socket.write(Buffer.concat([h, mk]))
        return new Promise((rs, rj) => waiters.set(mid, { resolve: rs, reject: rj }))
      }
      resolve({ send, close: () => socket.end() })
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await jget('/json/list')
      const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(250)
  }
  throw new Error('chrome not ready')
}

const proc = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=D:/BS-chat-os/.tmp/chrome-scroll',
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
const cdp = await connect(t.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
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
/* 按 .cr-name 前缀匹配会话行。
   注意：群聊的 .cr-name 里除了名字还拼了「N人」，还有置顶标记 <i>，
   所以 textContent 形如「回执演示·部分4人」—— 不能用全等匹配。 */
window.__rowExact = (name) => [...document.querySelectorAll('.chat-list .chat-row')].find(x => {
  const n = x.querySelector('.cr-name'); return n && n.textContent.replace(/\\s+/g,'').startsWith(name.replace(/\\s+/g,''))
}) || null
window.__openExact = (name) => { const r = window.__rowExact(name); if (!r) return false; r.click(); return true }
window.__scrollInfo = () => {
  const s = document.querySelector('.room-scroll'); if (!s) return null
  const room = document.querySelector('.room').getBoundingClientRect()
  const sr = s.getBoundingClientRect()
  const cs = getComputedStyle(s)
  const kids = [...s.children]
  const rect = (el) => el ? { top: Math.round(el.getBoundingClientRect().top - room.top), bottom: Math.round(el.getBoundingClientRect().bottom - room.top) } : null
  const f = rect(kids[0])
  const l = rect(kids[kids.length - 1])
  return {
    childCount: kids.length,
    clientHeight: s.clientHeight,
    scrollHeight: s.scrollHeight,
    scrollTop: s.scrollTop,
    maxScroll: s.scrollHeight - s.clientHeight,
    canScroll: s.scrollHeight - s.clientHeight > 2,
    justify: cs.justifyContent,
    padTop: parseFloat(cs.paddingTop),
    padBottom: parseFloat(cs.paddingBottom),
    areaTop: Math.round(sr.top - room.top),
    areaBottom: Math.round(sr.bottom - room.top),
    firstTop: f ? f.top : null,
    lastBottom: l ? l.bottom : null,
  }
}
window.__setScrollTop = (v) => { const s = document.querySelector('.room-scroll'); if (!s) return null; s.scrollTop = v; return s.scrollTop }
window.__click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true }
`

/** 打开某个会话并等消息渲染完 */
async function openConv(name) {
  const found = await waitFor(`!!window.__rowExact(${JSON.stringify(name)})`, 6000)
  if (!found) return false
  await js(`window.__openExact(${JSON.stringify(name)})`)
  await waitFor(`!!document.querySelector('.room-scroll .msg')`)
  await sleep(1200) // 等「贴底」那次 scrollIntoView 落定
  return true
}

try {
  await waitFor(`!!document.querySelector('.lg-demo-list button')`)
  try {
    await cdp.send('Runtime.evaluate', { expression: 'localStorage.clear()' })
  } catch {}
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1500)
  await waitFor(`!!document.querySelector('.lg-demo-list button')`)
  await js(HELPERS)
  await js(`(() => { const b=[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨')); if(b) b.click(); return true })()`)
  await waitFor(`!!document.querySelector('.chat-list .chat-row')`)
  await js(HELPERS)

  /* ============ A. 长会话：内容必须真的可以滚，且顶部可达 ============ */
  console.log(`\n─── A. 长会话「${longest.name}」（${longest.n} 条）───`)
  ok(await openConv(longest.name), `打开了「${longest.name}」`)

  const a0 = await js(`window.__scrollInfo()`)
  ok(!!a0 && a0.childCount >= 5, '消息已渲染', `子元素 ${a0?.childCount} 个`)
  ok(
    a0?.scrollHeight > a0?.clientHeight + 2,
    '内容溢出时 scrollHeight 必须计入溢出量（否则历史不可达）',
    `scrollHeight=${a0?.scrollHeight} clientHeight=${a0?.clientHeight}`
  )
  ok(a0?.maxScroll > 2, '存在可滚动距离', `maxScroll=${a0?.maxScroll}`)
  ok(a0?.scrollTop > 0, '打开会话默认贴底（scrollTop > 0）', `scrollTop=${a0?.scrollTop}`)
  ok(a0?.justify !== 'flex-end', '滚动容器没有用 justify-content:flex-end（已知不可滚动陷阱）', `justify=${a0?.justify}`)
  await shot('01-long-bottom')

  /* 滚到顶会触发「上翻加载更早的消息」。只要还有更早的，浏览器把 scrollTop
     顶到一个非零位置以保持视觉锚点 —— 所以「scrollTop 归零」不是一步能到的状态，
     得把历史翻完才行。顺带这里也成为了唯一验证分页真的可用的地方：
     一次翻一页（每页 40 条），翻到 `.room-more` 消失为止。 */
  let pages = 0
  let keptMore = true
  for (let i = 0; i < 10; i++) {
    keptMore = await js(`!!document.querySelector('.room-more')`)
    await js(`window.__setScrollTop(0)`)
    await sleep(900)
    pages++
    const info = await js(`window.__scrollInfo()`)
    if (info?.scrollTop === 0 && !(await js(`!!document.querySelector('.room-more')`))) break
  }
  const aTop = await js(`window.__scrollInfo()`)
  ok(
    !(await js(`!!document.querySelector('.room-more')`)),
    '★ 分页加载真的可用：一路翻到「没有更早的消息」',
    `翻了 ${pages} 次 · 总高 ${aTop?.scrollHeight}`
  )
  ok(aTop?.scrollTop === 0, '翻完历史后可以真正停在顶部（scrollTop 归零）', `scrollTop=${aTop?.scrollTop}`)
  ok(
    Math.abs((aTop?.firstTop ?? -999) - (aTop?.areaTop + aTop?.padTop)) <= 2,
    '滚到顶后最早那条消息完整可见（顶端裁掉 0px）',
    `首条top=${aTop?.firstTop} 应为=${aTop?.areaTop + aTop?.padTop}`
  )
  await shot('02-long-top')

  /* 滚到底 */
  await js(`window.__setScrollTop(999999)`)
  await sleep(500)
  const aBot = await js(`window.__scrollInfo()`)
  ok(
    Math.abs((aBot?.scrollTop ?? -1) - (aBot?.maxScroll ?? -2)) <= 2,
    '可以滚到底（scrollTop == maxScroll）',
    `scrollTop=${aBot?.scrollTop} max=${aBot?.maxScroll}`
  )

  /* ============ B. 短会话：设计意图「贴住输入区」不能丢 ============ */
  console.log(`\n─── B. 短会话「${shortest.name}」（${shortest.n} 条）───`)
  await js(`window.__click('.rh-back')`)
  await waitFor(`!document.querySelector('.room') && !!document.querySelector('.chat-list')`)
  js(HELPERS)
  ok(await openConv(shortest.name), `打开了「${shortest.name}」`)

  const b0 = await js(`window.__scrollInfo()`)
  if (b0 && !b0.canScroll) {
    ok(b0.scrollTop === 0, '内容不足一屏时没有多余滚动', `scrollTop=${b0?.scrollTop}`)
    ok(
      b0.firstTop >= b0.areaTop - 1,
      '短会话内容没有被推到滚动区上方（首条仍可见）',
      `首条top=${b0?.firstTop} 滚动区top=${b0?.areaTop}`
    )
    ok(
      Math.abs((b0.lastBottom ?? -999) - (b0.areaBottom - b0.padBottom)) <= 3,
      '短会话内容贴住输入区（底边对齐）',
      `末条bottom=${b0?.lastBottom} 应为≈${b0.areaBottom - b0.padBottom}`
    )
  } else {
    console.log(`  ℹ️ 「${shortest.name}」实际已超过一屏（${b0?.scrollHeight}/${b0?.clientHeight}），B 组跳过 —— 库里暂时没有短会话`)
  }
  await shot('03-short-bottom')
} finally {
  proc.kill()
}

/* 收尾：把自己造的长会话删掉。
   DELETE /conversations/:id 只是「退出成员」，会话和消息都还在 ——
   不从这里真删的话，每跑一次自检就多留一个 52 条的孤儿会话。 */
if (seeded) {
  const r = purgeDebris({ quiet: true })
  console.log(`\n已清理自检残留：${r.conversations} 个会话 / ${r.messages} 条消息`)
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
console.log(`截图目录：${OUT}`)
process.exit(failures === 0 ? 0 : 1)
