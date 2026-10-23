/**
 * 窄屏（真机宽度）布局校验：视口 390×844 与 360×780
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { ensureLoggedIn } from './lib/session.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9414
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

// 390×844 真机尺寸（iPhone 14）
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await sleep(2400)

// 应用有登录门：走 API 登录 + 注入 token（登录页已无演示账号列表）
const loginState = await ensureLoggedIn(evalJs)
console.log('login:', loginState === 'already' ? '已登录' : '已用 API 登录演示账号')

console.log('viewport 390×844')
await shot('21-phone-390')

const audit = await evalJs(`(() => {
  const de = document.documentElement
  const ph = document.querySelector('.phone')
  const r = ph.getBoundingClientRect()
  const over = [...document.querySelectorAll('.phone *')]
    .filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > window.innerWidth + 1 })
    .slice(0, 6)
    .map(el => el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName)
  return {
    docScrollW: de.scrollWidth,
    winW: window.innerWidth,
    docH: de.scrollHeight,
    winH: window.innerHeight,
    phoneRect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) },
    overflowEls: over,
  }
})()`)
console.log('  ', JSON.stringify(audit))

// 360×780 小屏安卓
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 3, mobile: true })
await sleep(1200)
console.log('viewport 360×780')
await shot('22-phone-360')

const audit2 = await evalJs(`(() => {
  const de = document.documentElement
  const r = document.querySelector('.phone').getBoundingClientRect()
  return { docScrollW: de.scrollWidth, winW: window.innerWidth, phoneW: Math.round(r.width), phoneH: Math.round(r.height) }
})()`)
console.log('  ', JSON.stringify(audit2))

cdp.close(); chrome.kill()
console.log('✅ 窄屏校验完成')
process.exit(0)
