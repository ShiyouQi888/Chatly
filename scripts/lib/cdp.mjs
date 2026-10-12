/**
 * CDP 小工具：给自检脚本用的，就两件事 ——
 *   1. 挑一个真的没人监听的调试端口
 *   2. 判断拿到的 target 是不是**我们这个应用**的页面
 *
 * 为什么必须做这两件事：
 *   自检脚本原来各自写死一个端口（9412…9481）。本机同时跑多个项目时，
 *   端口会被别人的 Chrome 占掉 —— 我这轮就撞上了：9481 监听的是一个挂着
 *   「邻传」页面的 Chrome。waitTarget() 拿到别人的 page target 就当成自己的，
 *   于是报出「登录页和聊天列表都没出现 —— 应用可能没挂载」。
 *   这个结论指向的方向**完全是错的**，会让人去查前端挂载，而真正的原因是端口被占。
 *
 *   所以：端口要动态拿，target 要按 URL 归属校验。宁可报「连不上调试端口」，
 *   也不要报一个错误的根因。
 */
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

/**
 * 拿一个空闲端口。设了 CDP_PORT 就听它的（方便手工复现）。
 * listen(0) 让内核分配，再立刻关掉 —— 中间有极小窗口会被别人抢，
 * 但比写死端口撞车的概率低几个数量级。
 */
export async function freePort() {
  if (process.env.CDP_PORT) return Number(process.env.CDP_PORT)
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 这个 target 是不是我们应用（appHost 前缀）的可见页面 */
export function isAppTarget(t, appHost) {
  return t.type === 'page' && !!t.webSocketDebuggerUrl && (t.url || '').startsWith(appHost)
}

/** 端口被别人的浏览器占了？返回那条 target 的 url，方便报错时说出来。 */
export function foreignTarget(list, appHost) {
  return (list || []).find((t) => t.type === 'page' && t.url && !(t.url || '').startsWith(appHost))
}

/* ================= 浏览器启动 + CDP 连接 =================
   这套东西原来是 check-emoji.mjs 里私有的。写第二份的代价很高
   （WebSocket 分帧、掩码、请求-响应配对都不好写对），
   所以新脚本一律从这里取，不要复制粘贴。 */

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/** 拉起一个开着调试端口的无头 Chrome，并打开 url */
export function launchChrome({ url, profileDir, width = 390, height = 844, port, extra = [] }) {
  return spawn(CHROME, [
    '--headless=new',
    /* 测试里点元素用的是 `el.click()`，不算用户手势 ——
       没有这个开关，`video.play()` 会被自动播放策略拦掉，
       断言就只能看到 paused=true，误判成「播放功能坏了」。 */
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    /* ⚠️ 必加。这台机器上设了 `http_proxy`/`HTTP_PROXY`（沙箱出口代理），
       Chromium 在 Windows 上虽然主要读 WinINET 的系统设置，但被代理接管时会
       连 127.0.0.1 也走代理 —— 表现是页面直接变成 `chrome-error://chromewebdata/`，
       自检则报「应用没挂载」。这个根因极具误导性：会让人去查前端挂载，
       而前端其实好得很（curl 打 127.0.0.1:5198 是 200）。
       本项目所有自检都只打本机端口，直接绕开代理是最稳的。 */
    '--no-proxy-server',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    `--window-size=${width},${height}`,
    ...extra,
    url,
  ], { stdio: 'ignore' })
}

/** 取调试端口上的 target 列表（/json/list） */
export function jget(port, path = '/json/list') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(s))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 等浏览器就绪并拿到**本应用**的页面 target。
 * 校验 url 归属：`waitAppTarget` 只认以 appHost 开头的页面，
 * 端口被别的浏览器占了时会直接报出对方的 url，而不是含糊地超时。
 */
export async function waitAppTarget(port, appHost, { tries = 80, every = 250 } = {}) {
  let seen = null
  for (let i = 0; i < tries; i++) {
    try {
      const l = await jget(port)
      const p = (l || []).find((t) => isAppTarget(t, appHost))
      if (p) return p
      seen = foreignTarget(l, appHost) || seen
    } catch {}
    await new Promise((r) => setTimeout(r, every))
  }
  throw new Error(
    seen
      ? `调试端口 ${port} 被别的浏览器占用了（页面是 ${seen.url}）—— 不是应用的问题，换个端口或关掉那个实例`
      : 'chrome not ready'
  )
}

/**
 * 连上 CDP 的 WebSocket。自己实现握手 + 分帧是因为不想为一条测试依赖装 ws 包
 * （前端零运行时依赖是项目硬约束，脚本侧也不想开这个口子）。
 * 返回 { send(method, params), close() }。
 */
export function connectCdp(wsUrl, onEvent) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl)
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
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
            } else if (m.method && onEvent) {
              /* 没有 id 的是浏览器主动推的事件（下载开始/进度、控制台、网络…）。
                 不接出来的话，「点了没反应」和「事件根本没发生」看起来一模一样。 */
              try {
                onEvent(m)
              } catch {}
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

/** 截图落盘（CDP 的 Page.captureScreenshot 返回 base64） */
export async function shoot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  return file
}
