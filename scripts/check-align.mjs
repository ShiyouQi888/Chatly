/**
 * 消息左右对齐校验：断言我方气泡贴右缘、对方气泡贴左缘
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import { URL as NodeURL } from 'node:url'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9415
const OUT = 'D:/BS-chat-os/shots'
fs.mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=900,1000', '--force-device-scale-factor=2',
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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
const evalJs = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
const shot = async (n) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.data, 'base64'))
  console.log('  saved', n)
}

await sleep(2400)

// 应用现在有登录门：先用演示账号一键登录
const loggedIn = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.lg-demo-list button')].find(x => x.textContent.includes('陈墨'))
  if (!b) return false
  b.click(); return true
})()`)
if (loggedIn) await sleep(2200)
console.log('login:', loggedIn ? '已登录演示账号' : '未找到登录按钮（可能已登录）')

// 打开第一个会话
await evalJs(`document.querySelector('.chat-row').click()`)
await sleep(1400)

// 测量每条消息
const report = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.room-scroll .msg')]
  const box = document.querySelector('.room-scroll').getBoundingClientRect()
  return rows.map(r => {
    const mine = r.classList.contains('is-mine')
    const b = r.querySelector('.bubble, .loc-card, .file-card, .voice, .img-bubble, .img-broken, .sticker-bubble, .media-bubble')
    if (!b) return null
    const br = b.getBoundingClientRect()
    const text = (b.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 14)
    const av = r.querySelector('.av-wrap')
    const avRect = av ? av.getBoundingClientRect() : null
    return {
      side: mine ? '我(右)' : '对方(左)',
      leftGap: Math.round(br.left - box.left),
      rightGap: Math.round(box.right - br.right),
      text,
      avatarLeftGap: avRect ? Math.round(avRect.left - box.left) : null,
      avatarRightGap: avRect ? Math.round(box.right - avRect.right) : null,
    }
  }).filter(Boolean)
})()`)

console.log('\n=== 消息对齐测量（内容区宽 ' + await evalJs('Math.round(document.querySelector(".room-scroll").getBoundingClientRect().width)') + 'px）===')
/* 判据（双方都带头像）：
   对方 → 头像贴左缘，且头像在气泡左侧
   我方 → 头像贴右缘，且头像在气泡右侧 */
let avOk = true
let sideOk = true
for (const m of report) {
  const isMine = m.side.startsWith('我')
  const avatarAtEdge = isMine ? m.avatarRightGap <= 18 : m.avatarLeftGap <= 18
  const avatarOutside = isMine ? m.avatarLeftGap > m.leftGap : m.avatarRightGap > m.rightGap
  if (!avatarAtEdge) avOk = false
  if (!avatarOutside) sideOk = false
  const ok = avatarAtEdge && avatarOutside
  console.log(
    `${ok ? '✅' : '❌'} ${m.side.padEnd(9)} 气泡[左${String(m.leftGap).padStart(3)}/右${String(m.rightGap).padStart(3)}]  ` +
    `头像[左${String(m.avatarLeftGap).padStart(3)}/右${String(m.avatarRightGap).padStart(3)}]  "${m.text}"`
  )
}

console.log('\n头像贴外缘（对方左 / 我方右）:', avOk ? '✅' : '❌')
console.log('头像在气泡外侧（未与气泡同侧）:', sideOk ? '✅' : '❌')

await shot('23-chat-align-390')
// 滚到顶部看对方消息
await evalJs(`document.querySelector('.room-scroll').scrollTop = 0`)
await sleep(600)
await shot('24-chat-align-top')

cdp.close(); chrome.kill()
console.log('\n✅ 对齐校验完成 →', OUT)
process.exit(0)
