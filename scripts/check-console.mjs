/**
 * 控制台体检：登录后遍历四个 Tab + 聊天室 + 设置面板 + 加号面板 + 搜索，
 * 收集 console.error / console.warn / 未捕获异常 / 加载失败。
 *
 * 存在的意义：这类问题（非法 DOM 嵌套、key 缺失、资源 404）不会让页面崩，
 * 只会静默降级 —— 靠肉眼看截图永远发现不了。
 *
 *   node scripts/check-console.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL as NodeURL } from 'node:url'
import { purgeMessagesAfter, maxMessageId, purgeOrphanUploads } from './lib/debris.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

/* 为了打开已读回执弹层，下面会真的发一条「控制台体检探针」—— 不清理的话
   每体检一次演示群里就多一条这种消息。开跑前记基线，收尾按基线删。 */
const msgBaseline = await maxMessageId()

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9441
const DIR = 'D:/BS-chat-os/.tmp/chrome-console'
fs.mkdirSync(DIR, { recursive: true })

const proc = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${DIR}`,
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--window-size=430,940',
    'http://127.0.0.1:5198/',
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jget = (p) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

async function waitTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await jget('/json/list')
      const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(250)
  }
  throw new Error('timeout')
}

function connect(wsUrl, onEvent) {
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
    req.on('upgrade', (_res, socket) => {
      socket.setNoDelay(true)
      socket.on('error', () => {}) // 关闭时会有 ECONNRESET，忽略即可
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
            } else if (m.method) {
              onEvent(m)
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

const problems = []

const t = await waitTarget()
const cdp = await connect(t.webSocketDebuggerUrl, (m) => {
  if (m.method === 'Runtime.consoleAPICalled') {
    const type = m.params.type
    if (type !== 'error' && type !== 'warning') return
    const text = m.params.args
      .map((a) => a.description || a.value || (a.preview ? JSON.stringify(a.preview) : a.type))
      .join(' ')
    problems.push(`[console.${type}] ${text}`)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(`[exception] ${m.params.exceptionDetails?.exception?.description || 'unknown'}`)
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry
    if (e.level === 'error' || e.level === 'warning') problems.push(`[log.${e.level}] ${e.text} :: ${e.url || ''}`)
  }
})

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description))
  return r.result?.value
}
const waitFor = async (expr, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await js(expr)) return true
    } catch {}
    await sleep(150)
  }
  return false
}

await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

const loginState = await ensureLoggedIn(js)
await waitFor(`!!document.querySelector('.chat-list .chat-row')`)
console.log(`  登录态：${loginState === 'already' ? '已登录' : '已用 API 登录演示账号'}`)

// 依次访问四个 Tab
for (const [i, name] of ['聊天', '动态', '发现', '我'].entries()) {
  await js(`(() => { const t=[...document.querySelectorAll('.tabbar .tab')][${i}]; if(t) t.click(); return true })()`)
  await sleep(1100)
  console.log(`  已访问 Tab：${name}`)
}

/* 资料编辑 + 头像选择器：这一片 DOM 最容易踩雷 ——
   头像按钮里套相机角标、预设网格是 12 个 button、日期是原生 date input、
   隐藏 file input 参与受控流程。都点开确认一遍不冒 React 告警。 */
await js(`(() => { const t=[...document.querySelectorAll('.tabbar .tab')][3]; if(t) t.click(); return true })()`)
await sleep(800)
if (await js(`!!document.querySelector('.me-editbtn')`)) {
  await js(`document.querySelector('.me-editbtn').click()`)
  await waitFor(`!!document.querySelector('.pe-field input#pe-nick')`)
  await sleep(500)
  await js(`document.querySelector('.pe-avatar-btn').click()`)
  await waitFor(`!!document.querySelector('.avp-grid')`, 5000)
  await sleep(600)
  await js(`(() => { const b=document.querySelector('.avp-close'); if(b) b.click(); return true })()`)
  await sleep(300)
  // 关掉编辑面板：不保存，避免体检脚本改到演示数据
  await js(`(() => { const b=document.querySelector('.sheet-mask'); if(b) b.click(); return true })()`)
  await sleep(400)
  console.log('  已打开资料编辑面板 + 头像选择器')
}

// 回到聊天 → 打开第一个会话 → 打开设置面板 → 打开加号面板
await js(`(() => { const t=[...document.querySelectorAll('.tabbar .tab')][0]; if(t) t.click(); return true })()`)
await sleep(700)
await js(`document.querySelector('.chat-list .chat-row').click()`)
await waitFor(`!!document.querySelector('.composer textarea')`)
await sleep(900)

/* 他人资料页：整屏覆盖层，里面有统计条 / 标签 / 底部动作按钮，也点开看一遍。
   注意顶部头像按钮在群聊里打开的是「会话设置」而不是资料页，两条分支都要能收干净。 */
if (await js(`!!document.querySelector('.rh-avatar')`)) {
  await js(`document.querySelector('.rh-avatar').click()`)
  const upOk = await waitFor(`!!document.querySelector('.up-root .up-idcard')`, 5000)
  await sleep(600)
  if (upOk) {
    await js(`(() => { const b=document.querySelector('.up-back'); if(b) b.click(); return true })()`)
  } else {
    await js(`(() => { const b=document.querySelector('.sheet-mask'); if(b) b.click(); return true })()`)
  }
  await sleep(500)
  console.log(`  已打开他人资料页：${upOk ? '是' : '否（当前会话是群聊，走的是会话设置）'}`)
}

await js(`(() => { const b=[...document.querySelectorAll('.rh-btn')].pop(); if(b) b.click(); return true })()`)
await sleep(900)
await js(`(() => { const b=document.querySelector('.sheet-mask'); if(b) b.click(); return true })()`)
await sleep(400)
await js(`(() => { const b=document.querySelector('.cp-btn[aria-label="更多"]'); if(b) b.click(); return true })()`)
await sleep(700)
await js(`(() => { const b=document.querySelector('.plus-mask'); if(b) b.click(); return true })()`)
await sleep(300)

/* 已读回执弹层：小头像簇是 <button>，详情面板是 role=dialog —— 这段交互最容易
   踩到非法 DOM 嵌套 / aria 用错之类的静默警告，必须真的点开一次。
   会话里没有「我方消息」就先发一条（发出去的必然是 mine，必然带收据）。 */
if (!(await js(`!!document.querySelector('.read-tag')`))) {
  await js(`(() => {
    const el = document.querySelector('.composer textarea'); if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '控制台体检探针')
    el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await waitFor(`!!document.querySelector('.cp-send')`)
  await js(`(() => { const b=document.querySelector('.cp-send'); if(b) b.click(); return true })()`)
  await waitFor(`!!document.querySelector('.read-tag')`)
}
if (await js(`!!document.querySelector('.read-tag')`)) {
  await js(`document.querySelector('.read-tag').click()`)
  const opened = await waitFor(`!!document.querySelector('.read-pop')`, 4000)
  await sleep(500)
  await js(`(() => { const b=document.querySelector('.read-pop-mask'); if(b) b.click(); return true })()`)
  await sleep(300)
  console.log(`  已打开已读回执弹层：${opened ? '是' : '否（没找到可点的收据）'}`)
}

// 打开搜索
await js(`document.querySelector('.rh-back').click()`)
await sleep(600)
await js(`(() => { const b=document.querySelector('.icon-btn'); if(b) b.click(); return true })()`)
await sleep(800)

proc.kill()

const gone = await purgeMessagesAfter(msgBaseline)
await purgeOrphanUploads({ quiet: false })
if (gone) console.log(`已清理本次体检产生的 ${gone} 条消息`)

console.log('\n─── 控制台问题 ───')
const noise = /favicon|Download the React DevTools|ExperimentalWarning/i
const real = [...new Set(problems.filter((p) => !noise.test(p)))]

if (real.length === 0) {
  console.log('✅ 无 console 报错 / 警告')
} else {
  real.forEach((p) => console.log('  •', p.slice(0, 300)))
  console.log(`\n❌ 共 ${real.length} 条（去重后）`)
}

process.exit(real.length === 0 ? 0 : 1)
