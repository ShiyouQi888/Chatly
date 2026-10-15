/**
 * 双账号实时联调：两个独立 Chrome 实例（各自 user-data-dir → 各自 localStorage / token）
 * 验证：登录 → 实时收未读 → 打开会话 → 已读回执回传 → 双向实时收消息 → 图片消息
 *
 *   node scripts/e2e-realtime.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { URL as NodeURL } from 'node:url'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = 'http://127.0.0.1:5198/'
const TMP = 'D:/BS-chat-os/.tmp'
const OUT = 'D:/BS-chat-os/shots/realtime'
fs.mkdirSync(TMP, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })

/* 生成一张有色带的 PNG 作为上传样本 —— 纯色的图截出来像空白，无法证明真的渲染了 */
function makeProbePng() {
  const W = 240
  const H = 160
  const raw = Buffer.alloc(H * (1 + W * 3))
  let o = 0
  for (let y = 0; y < H; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < W; x++) {
      let r = Math.round((255 * x) / W / 1.8 + 90)
      let g = Math.round((255 * y) / H / 2.2 + 70)
      let b = 235
      if (y >= 40 && y < 80) [r, g, b] = [250, 190, 90]
      else if (y >= 100 && y < 140) [r, g, b] = [90, 210, 165]
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const IMG_FILE = path.join(TMP, 'probe.png')
fs.writeFileSync(IMG_FILE, makeProbePng())

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 极简 CDP 客户端 ================= */
const jget = (port, p) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

async function waitTarget(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await jget(port, '/json/list')
      const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(250)
  }
  throw new Error(`chrome on ${port} not ready`)
}

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
    req.on('upgrade', (_res, socket) => {
      socket.setNoDelay(true)
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

/* ================= 启动两个独立浏览器 ================= */
function launch(port, dirName) {
  const dir = path.join(TMP, dirName)
  fs.mkdirSync(dir, { recursive: true })
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=430,940',
      APP,
    ],
    { stdio: 'ignore' }
  )
  return proc
}

async function makeSession(port, dirName, tag) {
  const proc = launch(port, dirName)
  const t = await waitTarget(port)
  const cdp = await connect(t.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`${tag}: ${JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)}`)
    return r.result?.value
  }

  const waitFor = async (expr, ms = 12000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        const v = await js(expr)
        if (v) return v
      } catch {}
      await sleep(150)
    }
    return null
  }

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }

  // profile 里可能残留上次运行的 token —— 先清干净并重载，保证每次都从登录页开始
  try {
    await cdp.send('Runtime.evaluate', { expression: 'localStorage.clear()' })
    await cdp.send('Page.reload', { ignoreCache: false })
  } catch {}
  await sleep(1400)

  return { proc, cdp, js, waitFor, shot, tag }
}

/* ================= 页面侧助手 ================= */
const HELPERS = `
window.__pickDemo = (label) => {
  const b = [...document.querySelectorAll('.lg-demo-list button')].find(x => x.textContent.includes(label))
  if (!b) return false
  b.click(); return true
}
window.__rowByName = (name) => {
  // 必须按 .cr-name（会话名）匹配：群聊行的「预览」里也会出现成员昵称，
  // 用整行 textContent 匹配会误命中别的会话。
  return [...document.querySelectorAll('.chat-list .chat-row')].find(x => {
    const n = x.querySelector('.cr-name')
    return n && n.textContent.replace(/\\s+/g, '').startsWith(name)
  }) || null
}
window.__openChat = (name) => {
  const row = window.__rowByName(name)
  if (!row) return false
  row.click(); return true
}
window.__rowUnread = (name) => {
  const row = window.__rowByName(name)
  if (!row) return null
  const b = row.querySelector('.badge')
  return b ? b.textContent.trim() : '0'
}
window.__type = (sel, val) => {
  const el = document.querySelector(sel)
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
window.__click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true }
window.__bubbleTexts = () => [...document.querySelectorAll('.room-scroll .bubble')].map(b => b.textContent.trim())
window.__readTags = () => document.querySelectorAll('.room-scroll .read-tag').length
window.__myReadTags = () => [...document.querySelectorAll('.room-scroll .msg.is-mine .read-tag')].length
/* 取某条我方消息的收据快照 —— 只数 .read-tag 的个数会「全是未读也通过」，
   必须看到 label / is-all 才说明已读真的回来了 */
window.__receiptOf = (text) => {
  const rows = [...document.querySelectorAll('.room-scroll .msg.is-mine')]
  const row = [...rows].reverse().find(r => r.textContent.includes(text))
  if (!row) return null
  const tag = row.querySelector('.read-tag')
  if (!tag) return null
  return {
    label: tag.querySelector('.rt-label')?.textContent.trim() || '',
    all: tag.classList.contains('is-all'),
    avatars: tag.querySelectorAll('.rt-av').length,
    dim: tag.querySelectorAll('.rt-av.is-unread').length,
    more: tag.querySelector('.rt-more')?.textContent.trim() || null,
  }
}
window.__imgCount = () => document.querySelectorAll('.room-scroll .img-bubble img').length
`

/* ================= 主流程 ================= */
;(async () => {
  console.log('══════ Chatly 双账号实时联调 ══════\n')

  // 本轮会往演示会话里发实时消息、传一张图 —— 开跑前记基线，收尾按基线删干净，
  // 否则每跑一轮 conv1 就多三条「实时消息-时间戳」，演示库没法看
  const { purgeDebris, purgeMessagesAfter, maxMessageId, purgeOrphanUploads } =
    await import('./lib/debris.mjs')
  await purgeDebris({ quiet: true })
  const msgBaseline = await maxMessageId()

  const A = await makeSession(9431, 'chrome-a', 'A')
  const B = await makeSession(9432, 'chrome-b', 'B')

  try {
    /* ---------- 1. 登录 ---------- */
    await A.waitFor(`!!document.querySelector('.lg-demo-list button')`)
    await B.waitFor(`!!document.querySelector('.lg-demo-list button')`)
    // 助手函数挂在 window 上，登录过程不刷新页面，注入一次即可全程复用
    await A.js(HELPERS)
    await B.js(HELPERS)
    await A.js(`window.__pickDemo('陈墨')`)
    await B.js(`window.__pickDemo('林小夏')`)

    const aIn = await A.waitFor(`!!document.querySelector('.tabbar') && !!document.querySelector('.chat-list .chat-row')`)
    const bIn = await B.waitFor(`!!document.querySelector('.tabbar') && !!document.querySelector('.chat-list .chat-row')`)
    ok(!!aIn, 'A(陈墨) 登录并进入聊天列表')
    ok(!!bIn, 'B(林小夏) 登录并进入聊天列表')

    const aName = await A.js(`document.querySelector('.me-uid, .brand') ? 'ok' : 'no'`)
    ok(aName === 'ok', 'A 渲染出应用骨架')

    await A.shot('00-A-list')
    await B.shot('00-B-list')


    /* ---------- 2. B 先读一次，清掉种子未读 ---------- */
    await B.js(`window.__openChat('陈墨')`)
    await B.waitFor(`!!document.querySelector('.room')`)
    await sleep(700)
    await B.js(`window.__click('.rh-back')`)
    await B.waitFor(`!document.querySelector('.room') && !!document.querySelector('.chat-list')`)
    const bUnreadBefore = Number((await B.js(`window.__rowUnread('陈墨')`)) || 0)
    ok(bUnreadBefore === 0, 'B 清空未读后列表无红点', `badge=${bUnreadBefore}`)

    /* ---------- 3. A 打开会话并发送 → B 列表实时出未读 ---------- */
    await A.js(`window.__openChat('林小夏')`)
    const aInRoom = await A.waitFor(`!!document.querySelector('.composer textarea') && !document.querySelector('.composer textarea').disabled`)
    ok(!!aInRoom, 'A 打开了与林小夏的会话')

    const stamp = Date.now()
    const textA = `实时消息-${stamp}`
    await A.js(`window.__type('.composer textarea', ${JSON.stringify(textA)})`)
    await A.waitFor(`!!document.querySelector('.cp-send')`)
    await A.js(`window.__click('.cp-send')`)

    const aSent = await A.waitFor(`window.__bubbleTexts().some(t => t.includes(${JSON.stringify(textA)}))`)
    ok(!!aSent, 'A 的消息已出现在自己的会话里', textA)

    // 用「相对基线增长」判定，避免被旁人同时在用 App 产生的未读干扰
    const bBadge = await B.waitFor(
      `(() => { const v = Number(window.__rowUnread('陈墨')) || 0; return v > ${bUnreadBefore} ? v : null })()`
    )
    ok(!!bBadge, 'B 在列表页实时收到未读红点', `${bUnreadBefore} → ${bBadge}`)

    /* ---------- 4. B 打开会话 → A 收到已读回执 ---------- */
    await B.js(`window.__openChat('陈墨')`)
    await B.waitFor(`!!document.querySelector('.composer textarea') && !document.querySelector('.composer textarea').disabled`)
    const bSaw = await B.waitFor(`window.__bubbleTexts().some(t => t.includes(${JSON.stringify(textA)}))`)
    ok(!!bSaw, 'B 打开会话后看到 A 的消息')

    /* 私聊只有 1 个对端，B 一进房间就该把 A 那条推成「全部已读」 */
    const aReceipt = await A.waitFor(
      `(() => { const v = window.__receiptOf(${JSON.stringify(textA)}); return v && v.all ? v : null })()`
    )
    ok(!!aReceipt, 'A 实时收到「已读」回执（1 对端 → 全部已读）', `label=${aReceipt?.label} 置灰=${aReceipt?.dim}`)
    ok(aReceipt?.avatars === 1 && aReceipt?.dim === 0, '收据里对端头像为「已读」态（不置灰）', `头像${aReceipt?.avatars} 置灰${aReceipt?.dim}`)

    /* ---------- 5. B 回复 → A 实时收到 ---------- */
    const textB = `收到啦-${Date.now()}`
    await B.js(`window.__type('.composer textarea', ${JSON.stringify(textB)})`)
    await B.waitFor(`!!document.querySelector('.cp-send')`)
    await B.js(`window.__click('.cp-send')`)

    const aGot = await A.waitFor(`window.__bubbleTexts().some(t => t.includes(${JSON.stringify(textB)}))`)
    ok(!!aGot, 'A 实时收到 B 的回复', textB)

    await A.shot('01-A-room')
    await B.shot('02-B-room')

    /* ---------- 6. 图片消息（真实上传） ---------- */
    const imgBefore = await B.js(`window.__imgCount()`)
    const aImgBefore = (await A.js(`window.__imgCount()`)) || 0
    // 记住上一张图的地址，用来证明「新图」真的换了一张，而不是读了历史残留
    const prevSrc = await A.js(
      `(() => { const a = [...document.querySelectorAll('.room-scroll .img-bubble img')]; const src = a.length ? a[a.length-1].getAttribute('src') : null; return src ? new URL(src, location.href).pathname : null })()`
    )

    await A.js(`window.__click('.cp-btn[aria-label="更多"]')`)
    const plusOpen = await A.waitFor(`!!document.querySelector('.plus-panel')`)
    ok(!!plusOpen, '打开加号面板')
    await A.js(
      `(() => { const b = [...document.querySelectorAll('.plus-item')].find(x => x.textContent.includes('图片')); if (b) { b.click(); return true } return false })()`
    )
    await sleep(400)

    let uploaded = false
    try {
      const doc = await A.cdp.send('DOM.getDocument', { depth: -1 })
      const node = await A.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
      if (node.nodeId) {
        await A.cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [IMG_FILE] })
        uploaded = true
      }
    } catch (e) {
      console.log('  (上传注入失败)', e.message)
    }
    ok(uploaded, '向隐藏 file input 注入了真实图片文件')

    const aImg = await A.waitFor(`window.__imgCount() > ${aImgBefore} ? window.__imgCount() : null`, 15000)
    ok(!!aImg, 'A 侧新增了图片消息', `${aImgBefore} → ${aImg}`)

    // 必须真的解码成功（naturalWidth > 0）、来自受成员权限保护的私有文件路由，且不是历史残留
    const meta = await A.waitFor(
      `(() => {
        const all = [...document.querySelectorAll('.room-scroll .img-bubble img')]
        const el = all[all.length - 1]
        if (!el || !el.complete || !el.naturalWidth) return null
        const r = el.getBoundingClientRect()
        return { nw: el.naturalWidth, nh: el.naturalHeight, w: Math.round(r.width), h: Math.round(r.height), src: new URL(el.getAttribute('src'), location.href).pathname }
      })()`,
      15000
    )
    ok(!!meta && meta.nw > 0, '图片真的解码成功（非空白占位）', meta ? `${meta.nw}×${meta.nh} 显示 ${meta.w}×${meta.h}` : '未解码')
    ok(!!meta && /^\/api\/v1\/files\/private\/.+\.png$/.test(meta.src), '图片地址指向成员校验的私有文件路由', meta?.src)
    ok(!!meta && meta.src !== prevSrc, '渲染的是本次新上传的图片', `prev=${prevSrc} now=${meta?.src}`)

    const bImg = await B.waitFor(`window.__imgCount() > ${imgBefore} ? window.__imgCount() : null`, 15000)
    ok(!!bImg, 'B 实时收到图片消息', `${imgBefore} → ${bImg}`)

    await A.shot('03-A-image')
    await B.shot('04-B-image')

    /* ---------- 7. 刷新后仍能恢复登录（token 持久化） ---------- */
    await A.cdp.send('Page.reload', { ignoreCache: false })
    await sleep(3000)
    const stillIn = await A.waitFor(`!!document.querySelector('.tabbar')`, 12000)
    const backToLogin = await A.js(`!!document.querySelector('.login')`)
    ok(!!stillIn && !backToLogin, '刷新后凭 localStorage token 自动恢复登录')

    /* ---------- 8. 点击图片可放大 ---------- */
    await A.js(HELPERS) // 刷新后页面上下文重置，助手函数需要重新注入
    await A.js(`window.__openChat('林小夏')`)
    await A.waitFor(`!!document.querySelector('.room-scroll .img-bubble')`)
    await A.js(`window.__click('.room-scroll .img-bubble')`)
    const viewer = await A.waitFor(`!!document.querySelector('.media-viewer')`)
    ok(!!viewer, '点击图片打开查看层')
    // 查看器必须自带关闭 / 保存 —— 原先只有一个光秃秃的 <img>，点开就出不来
    const bar = await A.js(
      `[...document.querySelectorAll('.media-viewer .mv-btn')].map(b => b.getAttribute('aria-label'))`
    )
    ok(bar.includes('关闭'), '查看层有关闭按钮', JSON.stringify(bar))
    ok(bar.includes('保存到本地'), '查看层有保存按钮', JSON.stringify(bar))
    await A.shot('05-A-viewer')
    await A.js(`window.__click('.media-viewer .mv-btn[aria-label="关闭"]')`)
    await sleep(600)
    ok(!(await A.js(`!!document.querySelector('.media-viewer')`)), '点关闭后查看层收起')
  } finally {
    A.proc.kill()
    B.proc.kill()
    // 先删本轮消息，再收孤儿文件 —— 顺序反了的话刚传的图还被消息指着，扫不到
    const gone = await purgeMessagesAfter(msgBaseline)
    await purgeDebris({ quiet: true })
    await purgeOrphanUploads({ quiet: false })
    if (gone) console.log(`已清理本轮产生的 ${gone} 条消息`)
  }

  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
  console.log(`截图目录：${OUT}`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
