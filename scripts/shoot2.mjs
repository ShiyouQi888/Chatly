/**
 * 补充截图：通知中心 + 搜索结果 + 群聊 + 状态
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import { URL as NodeURL } from 'node:url'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9413
const URL_ = 'http://127.0.0.1:5198/'
const OUT = 'D:/BS-chat-os/shots'
fs.mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1440,1000', '--force-device-scale-factor=2', URL_,
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
const target = await waitTarget()
const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 940, deviceScaleFactor: 2, mobile: false })

const evalJs = async (e) => {
  const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  return r.result?.value
}
const shot = async (n) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.data, 'base64'))
  console.log('  saved', n)
}
const clickText = (t, sel = 'button') => evalJs(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim()===${JSON.stringify(t)})||[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(t)}));if(!e)return false;e.click();return true})()`)

await sleep(2600)

console.log('通知中心')
await evalJs(`document.querySelectorAll('.chat-head .icon-btn').length`)
// 通过 tab 进入聊天后点标题栏搜索旁的加号 → 改用直接点通知：无入口，用 chat-head-act 第一颗(搜索)，再退；此处用 I'll open via search overlay 替代
await evalJs(`document.querySelector('.chat-head-act .icon-btn').click()`)
await sleep(700)
await evalJs(`(()=>{const i=document.querySelector('.sp-field input');i.value='林';i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await sleep(900)
await shot('16-search-results')
await evalJs(`document.querySelector('.sub-back').click()`)
await sleep(600)

console.log('群聊会话（设计部）')
await evalJs(`[...document.querySelectorAll('.chat-row')][1].click()`)
await sleep(900)
await shot('17-group-room')
console.log('群聊设置')
await evalJs(`(()=>{const b=[...document.querySelectorAll('.rh-btn')];b[b.length-1].click();return true})()`)
await sleep(1000)
await shot('18-group-info')
await evalJs(`document.querySelector('.sheet-root .sheet-mask')?.click()`)
await sleep(500)
await evalJs(`document.querySelector('.rh-back').click()`)
await sleep(700)

console.log('文件中心会话')
await evalJs(`[...document.querySelectorAll('.chat-row')].find(r=>r.textContent.includes('文件中心')).click()`)
await sleep(900)
await shot('19-file-chat')
await evalJs(`document.querySelector('.rh-back').click()`)
await sleep(700)

console.log('我的 → 账号与安全')
await clickText('我', '.tab'); await sleep(800)
await clickText('账号与安全', '.row'); await sleep(900)
await shot('20-me-security')

cdp.close(); chrome.kill()
console.log('✅ 补充截图完成')
process.exit(0)
