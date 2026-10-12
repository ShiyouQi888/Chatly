/**
 * Chatly 截图脚本：用 CDP 驱动本机 Chrome，逐 Tab 截图
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import { URL as NodeURL } from 'node:url'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9412
const URL = 'http://127.0.0.1:5198/'
const OUT = process.argv[2] || 'D:/BS-chat-os/shots'

fs.mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--window-size=1440,1000',
  '--force-device-scale-factor=2',
  URL,
], { stdio: 'ignore' })

const jget = (path) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

async function waitTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await jget('/json/list')
      const p = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('CDP target timeout')
}

/* 极简 WebSocket 客户端（仅支持文本帧，够 CDP 用） */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(wsUrl)
    const key = Buffer.from(String(Math.random())).toString('base64')
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true)
      let buf = Buffer.alloc(0)
      const waiters = new Map()
      let id = 0

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) break
          const fin = (buf[0] & 0x80) !== 0
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
          if (!fin) continue
          try {
            const msg = JSON.parse(payload.toString('utf8'))
            if (msg.id && waiters.has(msg.id)) {
              const { resolve: rs, reject: rj } = waiters.get(msg.id)
              waiters.delete(msg.id)
              msg.error ? rj(new Error(JSON.stringify(msg.error))) : rs(msg.result)
            }
          } catch {}
        }
      })

      const send = (method, params = {}) => {
        const mid = ++id
        const data = Buffer.from(JSON.stringify({ id: mid, method, params }))
        const mask = Buffer.from([1, 2, 3, 4])
        let header
        if (data.length < 126) {
          header = Buffer.alloc(6)
          header[0] = 0x81
          header[1] = 0x80 | data.length
          mask.copy(header, 2)
        } else if (data.length < 65536) {
          header = Buffer.alloc(8)
          header[0] = 0x81
          header[1] = 0x80 | 126
          header.writeUInt16BE(data.length, 2)
          mask.copy(header, 4)
        } else {
          header = Buffer.alloc(14)
          header[0] = 0x81
          header[1] = 0x80 | 127
          header.writeBigUInt64BE(BigInt(data.length), 2)
          mask.copy(header, 10)
        }
        const masked = Buffer.alloc(data.length)
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4]
        socket.write(Buffer.concat([header, masked]))
        return new Promise((rs, rj) => waiters.set(mid, { resolve: rs, reject: rj }))
      }

      resolve({ send, close: () => socket.end() })
    })
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const target = await waitTarget()
const cdp = await connect(target.webSocketDebuggerUrl)

await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 560,
  height: 940,
  deviceScaleFactor: 2,
  mobile: false,
})

async function evalJs(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result?.value
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log('  saved', name)
}

/** 点击含指定文本的元素 */
async function clickByText(text, sel = 'button') {
  const ok = await evalJs(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = els.find(e => e.textContent.trim() === ${JSON.stringify(text)})
      || els.find(e => e.textContent.includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`)
  if (!ok) console.log('  ⚠ 未找到可点击元素:', text)
  return ok
}

await sleep(2500)

console.log('Tab 1 聊天列表')
await shot('01-chat-list')

console.log('打开会话 → 私聊')
await evalJs(`document.querySelector('.chat-row').click()`)
await sleep(900)
await shot('02-chat-room')

console.log('会话：加号面板')
await clickByText('', '.cp-btn')
await sleep(700)
await shot('03-chat-plus')
await evalJs(`document.querySelector('.plus-mask')?.click()`)
await sleep(500)

console.log('会话：长按消息菜单')
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.bubble')][3];
  if (b) b.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true}));
})()`)
await sleep(800)
await shot('04-chat-msgmenu')
await evalJs(`document.querySelector('.sheet-mask')?.click()`)
await sleep(500)

console.log('会话：会话设置')
await evalJs(`document.querySelectorAll('.rh-btn')[document.querySelectorAll('.rh-btn').length-1].click()`)
await sleep(900)
await shot('05-chat-info')
await evalJs(`document.querySelector('.sheet-root .sheet-mask')?.click()`)
await sleep(400)
await evalJs(`document.querySelector('.rh-back').click()`)
await sleep(700)

console.log('Tab 2 动态')
await clickByText('动态', '.tab')
await sleep(900)
await shot('06-moments')

console.log('Tab 3 发现')
await clickByText('发现', '.tab')
await sleep(900)
await shot('07-discover-recommend')

await clickByText('附近')
await sleep(800)
await shot('08-discover-nearby')

await clickByText('活动')
await sleep(800)
await shot('09-discover-events')

await clickByText('用户')
await sleep(800)
await shot('10-discover-users')

console.log('Tab 4 我')
await clickByText('我', '.tab')
await sleep(900)
await shot('11-me-profile')

console.log('我 · 主题外观')
await clickByText('主题外观', '.row')
await sleep(900)
await shot('12-me-theme')
await evalJs(`document.querySelector('.sub-back').click()`)
await sleep(700)

console.log('我 · 隐私设置')
await clickByText('隐私设置', '.row')
await sleep(900)
await shot('13-me-privacy')
await evalJs(`document.querySelector('.sub-back').click()`)
await sleep(700)

console.log('我 · 文件中心')
await evalJs(`document.querySelector('.sub-back')`)
await clickByText('最近文件')
await sleep(900)
await shot('14-me-files')
await evalJs(`document.querySelector('.sub-back').click()`)
await sleep(600)

console.log('搜索面板')
await clickByText('聊天', '.tab')
await sleep(600)
await evalJs(`document.querySelector('.chat-head-act .icon-btn').click()`)
await sleep(800)
await shot('15-search')
await evalJs(`document.querySelector('.sub-back').click()`)
await sleep(500)

cdp.close()
chrome.kill()
console.log('✅ 全部截图完成 →', OUT)
process.exit(0)
