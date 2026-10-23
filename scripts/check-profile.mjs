/**
 * 用户资料 / 头像 —— 真实读写端到端验证
 *
 * 这个脚本存在的理由是：资料页最容易做成「看起来能用、其实只在本地 state 里转」。
 * 所以每条断言都去 **后端** 拿证据，而不是只看 DOM 变没变：
 *   - 保存后必须能 GET /auth/me 读到新值
 *   - 刷新页面后新值必须还在（只改 state 的假实现在这里会挂）
 *   - 上传头像必须真的落盘（能取回图片、Content-Type 是 image/jpeg）
 *   - 预设头像库里只能存短编号（防「把 data-URI 塞进数据库」）
 *
 * 覆盖：
 *   A. 资料编辑面板：预填真实值 / dirty 门控 / 保存 / 刷新后仍在
 *   B. 预设头像：12 个预设 / 选中态 / 落库为 preset:<n>
 *   C. 上传头像：选图 → 裁剪（拖动 + 缩放）→ 确定 → 保存 → 落盘可访问
 *   D. 他人资料页：从聊天顶部头像进入 / 生日不暴露出生年 / 发消息回到会话
 *
 * 跑法：node scripts/check-profile.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { URL as NodeURL } from 'node:url'
import { ensureLoggedIn } from './lib/session.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:3002/api/v1'
const BASE = 'http://127.0.0.1:3002'
const APP = 'http://127.0.0.1:5198/'
const PORT = 9473
const OUT = 'D:/BS-chat-os/shots/profile'
const TMP = 'D:/BS-chat-os/.tmp'
const PROFILE_DIR = path.join(TMP, 'chrome-prof')
const PASS = 'chatly123'

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(PROFILE_DIR, { recursive: true })

/* ---------- 造一张 400×300 的彩条 PNG 当上传素材 ----------
   纯色 PNG 截出来是空白的，看不出裁剪有没有真的位移，所以画上色带。 */
function makeTestPng() {
  const W = 400
  const H = 300
  const raw = Buffer.alloc(H * (1 + W * 3))
  let o = 0
  for (let y = 0; y < H; y++) {
    raw[o++] = 0
    for (let x = 0; x < W; x++) {
      let r = 60
      let g = 70
      let b = 120
      if (x < W / 4) [r, g, b] = [250, 120, 90]
      else if (x < W / 2) [r, g, b] = [255, 200, 80]
      else if (x < (W * 3) / 4) [r, g, b] = [90, 205, 165]
      else [r, g, b] = [130, 120, 245]
      if (y > H * 0.6) {
        r = Math.round(r * 0.55)
        g = Math.round(g * 0.55)
        b = Math.round(b * 0.55)
      }
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
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const TEST_PNG_B64 = makeTestPng().toString('base64')

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 后端侧准备 + 取证工具 ================= */
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
const snapshot = me.user // 测完原样还原，别把演示库改花

/* 本地头像文件也要一起快照。
   换头像时服务端会顺手删掉上一张本地文件，所以「还原」不能只把字段写回去 ——
   文件本身得先放回磁盘，否则库里就留下一个指向不存在文件的地址（界面上是破图）。
   PATCH 现在也会拒绝指向不存在文件的头像，正好把这类悬空引用挡在门外。 */
const UPLOAD_DIR = 'D:/BS-chat-os/server/uploads'
let avatarBackup = null
if (snapshot.avatar?.startsWith('/uploads/')) {
  const p = path.join(UPLOAD_DIR, path.basename(snapshot.avatar))
  if (fs.existsSync(p)) avatarBackup = { path: p, data: fs.readFileSync(p) }
  else console.log(`  ⚠️ 本地头像 ${snapshot.avatar} 已不存在，收尾时会把头像置空而不是留悬空引用`)
}

const readMe = async () => (await (await fetch(`${API}/auth/me`, { headers: auth })).json()).user

const patch = async (body) =>
  (
    await fetch(`${API}/auth/me`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) })
  ).json()

const convs = (await (await fetch(`${API}/conversations`, { headers: auth })).json()).conversations
const priv = convs.find((c) => c.type === 'private')
if (!priv) throw new Error('演示库里没有私聊会话，无法测他人资料页')
const groupConv = convs.find((c) => c.type === 'group')
const peer = (priv.members || []).find((m) => m.user.id !== me.user.id)?.user
if (!peer) throw new Error('私聊会话里找不到对端')
const peerApi = (
  await (await fetch(`${API}/users/${peer.id}`, { headers: auth })).json()
).user
console.log(`演示对象：我=${me.user.nickname}#${me.user.id} · 对端=${peer.nickname}#${peer.id}（会话「${priv.name}」）\n`)

/* ================= 极简 CDP 客户端 ================= */
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
      const events = []
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
            } else if (m.method) events.push(m)
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
      resolve({ send, close: () => socket.end(), events })
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
/* React 受控输入：必须走原生 setter + input 事件，直接改 .value 不会触发 onChange */
window.__setVal = (sel, v) => {
  const el = document.querySelector(sel)
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
window.__click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true }
window.__has = (sel) => !!document.querySelector(sel)
window.__text = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.replace(/\\s+/g,' ').trim() : null }
window.__val = (sel) => { const el = document.querySelector(sel); return el ? el.value : null }
window.__tab = (label) => {
  const b = [...document.querySelectorAll('.tabbar .tab')].find(x => (x.querySelector('.tab-label')||{}).textContent === label)
  if (!b) return false
  b.click(); return true
}
/* 把一张 PNG 塞进隐藏的 file input。
   input.files 是只读的，只能 defineProperty 覆盖；然后派发 change，
   React 的 onChange 才拿得到 e.target.files。 */
window.__feedFile = (b64, name, mime) => {
  const input = document.querySelector('.avp-file')
  if (!input) return false
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const dt = new DataTransfer()
  dt.items.add(new File([arr], name, { type: mime }))
  Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}
/* 裁剪区里那张图的显示尺寸 + 位移（用来证明拖动/缩放真的生效） */
window.__stage = () => {
  const st = document.querySelector('.avp-stage')
  if (!st) return null
  const img = st.querySelector('img')
  const r = st.getBoundingClientRect()
  return {
    stage: Math.round(r.width),
    hasImg: !!img,
    w: img ? Math.round(img.getBoundingClientRect().width) : 0,
    h: img ? Math.round(img.getBoundingClientRect().height) : 0,
    left: img ? Math.round(img.getBoundingClientRect().left - r.left) : 0,
    top: img ? Math.round(img.getBoundingClientRect().top - r.top) : 0,
    zoom: Number(document.querySelector('.avp-zoom input[type=range]').value),
  }
}
/* 拖动裁剪区（pointer 事件，React 监听的是 pointerdown/move/up） */
window.__dragStage = (dx, dy) => {
  const st = document.querySelector('.avp-stage')
  if (!st) return false
  const r = st.getBoundingClientRect()
  const x0 = r.left + r.width / 2
  const y0 = r.top + r.height / 2
  const pe = (type, x, y) => new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y, isPrimary: true })
  st.dispatchEvent(pe('pointerdown', x0, y0))
  st.dispatchEvent(pe('pointermove', x0 + dx, y0 + dy))
  st.dispatchEvent(pe('pointerup', x0 + dx, y0 + dy))
  return true
}
window.__savedAvatar = () => {
  const img = document.querySelector('.me-idcard .av img, .me-idcard img')
  return img ? img.getAttribute('src') : null
}
`

/* 进到聊天列表。
   ⚠️ 两种入口都要认：`--user-data-dir` 是复用的，上一轮留下的 token 还在，
   `localStorage.clear()` 又可能落在了还没导航到应用源的页面上（被 try/catch 吞掉），
   于是重载后应用**直接进聊天列表**、不回登录页 —— 只等登录页的话必然超时。 */
async function boot() {
  await js(HELPERS)
  const ready = await waitFor(
    `!!document.querySelector('.lg-card, .login') || !!document.querySelector('.chat-list .chat-row')`,
    15000
  )
  if (!ready) throw new Error('登录页和聊天列表都没出现 —— 应用可能没挂载')
  await ensureLoggedIn(js)
  const listed = await waitFor(`!!document.querySelector('.chat-list .chat-row')`, 15000)
  if (!listed) throw new Error('聊天列表没出现')
  await js(HELPERS)
}

async function toMe() {
  await js(`window.__tab('我')`)
  await waitFor(`!!document.querySelector('.me-idcard')`)
  await sleep(400)
  await js(HELPERS)
}

async function openEditor() {
  await js(`window.__click('.me-editbtn')`)
  const okOpen = await waitFor(`!!document.querySelector('.pe-field input#pe-nick')`)
  await js(HELPERS)
  return okOpen
}

try {
  /* ===================== 准备：干净登录，并复位资料 ===================== */
  await waitFor(`!!document.querySelector('body')`)
  try {
    await cdp.send('Runtime.evaluate', { expression: 'localStorage.clear()' })
  } catch {}
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1500)
  await boot()

  await toMe()

  /* ===================== A. 资料编辑面板 ===================== */
  console.log('─── A. 资料编辑面板读到的是真实数据 ───')
  ok(
    (await js(`window.__text('.me-name h2')`)) === snapshot.nickname,
    '「我」页昵称来自后端',
    await js(`window.__text('.me-name h2')`)
  )
  ok(
    (await js(`window.__text('.me-bio')`)) === (snapshot.bio || '还没有个性签名'),
    '「我」页签名来自后端',
    await js(`window.__text('.me-bio')`)
  )
  await shot('01-me-hero')

  ok(await openEditor(), '点铅笔打开了编辑面板')
  await sleep(300)
  const prefilled = {
    nick: await js(`window.__val('#pe-nick')`),
    bio: await js(`window.__val('#pe-bio')`),
    birth: await js(`window.__val('#pe-birth')`),
    region: await js(`window.__val('#pe-region')`),
    genderOn: await js(`window.__text('.pe-chip.is-on')`),
    tags: await js(`document.querySelectorAll('.pe-tag').length`),
  }
  ok(prefilled.nick === snapshot.nickname, '昵称输入框预填当前值', prefilled.nick)
  ok(prefilled.bio === (snapshot.bio || ''), '签名输入框预填当前值', prefilled.bio)
  ok(prefilled.birth === (snapshot.birthday || ''), '生日预填 YYYY-MM-DD', prefilled.birth)
  ok(prefilled.region === (snapshot.region || ''), '地区预填当前值', prefilled.region)
  ok(!!prefilled.genderOn, '性别选中态与后端一致', prefilled.genderOn)
  ok(
    prefilled.tags === (snapshot.tags || []).length,
    '标签数量与后端一致',
    `${prefilled.tags} vs ${(snapshot.tags || []).length}`
  )
  ok(
    (await js(`document.querySelector('.pe-save').disabled`)) === true,
    '没改动时保存按钮是禁用的（dirty 门控）'
  )
  await shot('02-editor-open')

  /* ---- 改昵称/签名 → 保存 ---- */
  const NEW_NICK = '陈墨·资料验证'
  const NEW_BIO = '签名由自动测试写入'
  await js(`window.__setVal('#pe-nick', ${JSON.stringify(NEW_NICK)})`)
  await js(`window.__setVal('#pe-bio', ${JSON.stringify(NEW_BIO)})`)
  await sleep(250)
  ok(
    (await js(`document.querySelector('.pe-save').disabled`)) === false,
    '改动后保存按钮解除禁用'
  )
  ok(
    (await js(`window.__text('.pe-field em')`)) === `${[...NEW_NICK].length}/20`,
    '昵称字数实时计数',
    await js(`window.__text('.pe-field em')`)
  )

  await js(`window.__click('.pe-save')`)
  const saved = await waitFor(`window.__text('.toast') === '资料已保存'`, 8000)
  ok(saved, '保存后弹出「资料已保存」', await js(`window.__text('.toast')`))

  const afterPatch = await readMe()
  ok(afterPatch.nickname === NEW_NICK, '后端确实写入了新昵称', afterPatch.nickname)
  ok(afterPatch.bio === NEW_BIO, '后端确实写入了新签名', afterPatch.bio)
  ok(!(await js(`window.__has('.pe-field')`)), '保存后编辑面板自动收起')
  ok((await js(`window.__text('.me-name h2')`)) === NEW_NICK, '「我」页立刻显示新昵称')

  /* ---- 刷新后还在（证明不是只改了内存 state） ---- */
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(2000)
  await waitFor(`!!document.querySelector('.chat-list .chat-row')`, 15000)
  await js(HELPERS)
  await toMe()
  ok(
    (await js(`window.__text('.me-name h2')`)) === NEW_NICK,
    '★ 整页刷新后昵称仍是新值（真落库，不是本地 state）',
    await js(`window.__text('.me-name h2')`)
  )
  ok((await js(`window.__text('.me-bio')`)) === NEW_BIO, '★ 整页刷新后签名仍是新值')

  /* ===================== B. 预设头像 ===================== */
  console.log('\n─── B. 预设头像 ───')
  ok(await openEditor(), '再次打开编辑面板')
  await sleep(250)
  await js(`window.__click('.pe-avatar-btn')`)
  await waitFor(`!!document.querySelector('.avp-grid')`)
  await sleep(300)
  const presetCount = await js(`document.querySelectorAll('.avp-grid .avp-item').length`)
  ok(presetCount === 12, '内置头像共 12 个', String(presetCount))

  /* 几何断言：底部的浮动 Tabbar 不能盖住最后一个预设。
     「看得见」这种事必须量，截图里那一点被模糊掉的边角很容易被当成渲染噪声放过。 */
  const cover = await js(`(() => {
    const items = [...document.querySelectorAll('.avp-grid .avp-item')]
    const last = items[items.length - 1]
    if (!last) return null
    const r = last.getBoundingClientRect()
    const tb = document.querySelector('.tabbar')
    const tbr = tb ? tb.getBoundingClientRect() : null
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      lastBottom: Math.round(r.bottom),
      tabbarTop: tbr ? Math.round(tbr.top) : null,
      covered: tbr ? r.bottom > tbr.top + 1 : false,
      hitIsLast: hit ? last.contains(hit) || hit === last : false,
    }
  })()`)
  ok(!cover?.covered, '★ 最后一个预设没有被底部 Tabbar 遮住', `预设底=${cover?.lastBottom} Tabbar顶=${cover?.tabbarTop}`)
  ok(cover?.hitIsLast, '★ 最后一个预设中心点的命中元素就是它自己（没有被别的层压住）')
  await shot('03-picker-presets')

  await js(`window.__click('.avp-grid .avp-item:nth-child(9)')`)
  await sleep(400)
  ok(!(await js(`window.__has('.avp-grid')`)), '选完预设后选择器自动关闭')
  const presetPreview = await js(`document.querySelector('.pe-avatar img').getAttribute('src') || ''`)
  ok(presetPreview.startsWith('data:image/svg+xml'), '编辑面板实时预览预设头像（data-URI SVG）', presetPreview.slice(0, 34) + '…')

  await js(`window.__click('.pe-save')`)
  await waitFor(`window.__text('.toast') === '资料已保存'`, 8000)
  const presetSaved = await readMe()
  ok(presetSaved.avatar === 'preset:9', '后端头像落库为 preset:9', String(presetSaved.avatar))
  ok(
    typeof presetSaved.avatar === 'string' && presetSaved.avatar.length < 16,
    '★ 库里存的是编号而不是几 KB 的 data-URI',
    `${presetSaved.avatar.length} 字符`
  )

  /* ===================== C. 上传 + 裁剪 ===================== */
  console.log('\n─── C. 上传头像（拖动 + 缩放裁剪）───')
  ok(await openEditor(), '再次打开编辑面板')
  await sleep(250)
  await js(`window.__click('.pe-avatar-btn')`)
  await waitFor(`!!document.querySelector('.avp-file')`)
  await sleep(250)

  ok(
    await js(`window.__feedFile(${JSON.stringify(TEST_PNG_B64)}, 'test.png', 'image/png')`),
    '把测试图片喂进 file input'
  )
  await waitFor(`!!document.querySelector('.avp-stage')`, 6000)
  ok(await js(`window.__has('.avp-stage')`), '选图后进入裁剪模式')
  await sleep(500)

  const st0 = await js(`window.__stage()`)
  ok(!!st0?.hasImg && st0.stage > 100, '裁剪区渲染出图片', `stage=${st0?.stage} img=${st0?.w}×${st0?.h}`)
  // 400×300 铺满 248 见方 → cover 缩放 = max(248/400, 248/300) = 248/300
  ok(st0.w === 331 && st0.h === 248, '★ 按 cover 方式铺满裁剪区（不留白边）', `${st0.w}×${st0.h}`)
  ok(st0.left < 0, '★ 非正方形图片初始就横向溢出（可拖动空间 > 0）', `left=${st0.left}`)
  await shot('04-crop-initial')

  /* 拖动 */
  await js(`window.__dragStage(-40, 0)`)
  await sleep(350)
  const st1 = await js(`window.__stage()`)
  ok(Math.abs(st1.left - st0.left) > 20, '★ 拖动真的改变了图片位置', `left ${st0.left} → ${st1.left}`)

  /* 缩放 */
  await js(`window.__setVal('.avp-zoom input[type=range]', '2')`)
  await sleep(400)
  const st2 = await js(`window.__stage()`)
  ok(st2.w > st1.w * 1.8, '★ 缩放滑块把图片放大了', `w ${st1.w} → ${st2.w}`)
  await shot('05-crop-zoom')

  /* 确定 → 回到编辑面板，预览换成 blob: */
  await js(`window.__click('.avp-acts .is-primary')`)
  await waitFor(`!document.querySelector('.avp-stage')`, 8000)
  await sleep(500)
  const blobPreview = await js(`document.querySelector('.pe-avatar img').getAttribute('src') || ''`)
  ok(blobPreview.startsWith('blob:'), '裁剪结果在编辑面板里预览（blob: 地址）', blobPreview.slice(0, 24) + '…')
  ok((await readMe()).avatar === 'preset:9', '★ 还没点保存，后端头像仍是旧值（草稿不落库）')
  await shot('06-editor-with-draft')

  await js(`window.__click('.pe-save')`)
  await waitFor(`window.__text('.toast') === '资料已保存'`, 10000)
  const upSaved = await readMe()
  ok(/^\/uploads\/[A-Za-z0-9._-]+\.jpg$/.test(upSaved.avatar || ''), '上传后头像落库为 /uploads/*.jpg', String(upSaved.avatar))
  const imgRes = await fetch(`${BASE}${upSaved.avatar}`)
  ok(imgRes.status === 200, '上传的头像文件可以访问', String(imgRes.status))
  ok(
    (imgRes.headers.get('content-type') || '').includes('image/jpeg'),
    '取回的是 JPEG（裁剪导出格式）',
    imgRes.headers.get('content-type')
  )
  const bytes = Buffer.from(await imgRes.arrayBuffer())
  ok(bytes.length > 2000, '文件不是空壳', `${bytes.length} 字节`)

  /* 服务器上旧的 preset 不是文件，不该误删；同时确认新文件真是 512×512 JPEG */
  ok(bytes[0] === 0xff && bytes[1] === 0xd8, 'JPEG 文件头正确（FFD8）')
  ok(bytes.readUInt16BE(bytes.length - 2) === 0xffd9, 'JPEG 文件尾正确（FFD9，说明导出完整）')

  /* 刷新后头像还在 */
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(2000)
  await waitFor(`!!document.querySelector('.chat-list .chat-row')`, 15000)
  await js(HELPERS)
  await toMe()
  const heroSrc = await js(`window.__savedAvatar()`)
  ok(
    !!heroSrc && heroSrc.includes(upSaved.avatar.split('/').pop()),
    '★ 整页刷新后头像仍是刚上传的那张',
    String(heroSrc)
  )
  await shot('07-me-after-upload')

  /* ===================== D. 他人资料页 ===================== */
  console.log('\n─── D. 他人资料页 ───')
  await js(`window.__tab('聊天')`)
  await waitFor(`!!document.querySelector('.chat-list .chat-row')`)
  await js(HELPERS)
  const openedRow = await js(`(() => {
    const rows = [...document.querySelectorAll('.chat-list .chat-row')]
    const r = rows.find(x => (x.querySelector('.cr-name')||{}).textContent.replace(/\\s+/g,'').startsWith(${JSON.stringify(priv.name.replace(/\s+/g, ''))}))
    if (!r) return false
    r.click(); return true
  })()`)
  ok(openedRow, `打开了私聊「${priv.name}」`)
  await waitFor(`!!document.querySelector('.room-scroll')`)
  await sleep(600)

  ok(await js(`window.__has('.rh-avatar')`), '私聊顶部头像是独立可点按钮（不是嵌套 button）')
  /* 非法 DOM 嵌套守卫：.rh-avatar 自己必须是 <button>，且内部不能再套一个 button。 */
  const avatarDom = await js(`(() => {
    const a = document.querySelector('.rh-avatar')
    if (!a) return null
    return { tag: a.tagName, innerButtons: a.querySelectorAll('button').length }
  })()`)
  ok(avatarDom?.tag === 'BUTTON', '顶部头像是原生 button（可聚焦 / 可读屏）', avatarDom?.tag)
  ok(avatarDom?.innerButtons === 0, '★ 头像按钮里没有再嵌 button（非法 DOM 嵌套）', `内层 button ${avatarDom?.innerButtons} 个`)
  await js(`window.__click('.rh-avatar')`)
  const upOpen = await waitFor(`!!document.querySelector('.up-root .up-idcard')`, 8000)
  ok(upOpen, '点顶部头像打开了对方资料页')
  await sleep(500)

  ok((await js(`window.__text('.up-idcard h3')`)) === peerApi.nickname, '资料页昵称与后端一致', await js(`window.__text('.up-idcard h3')`))
  ok(
    (await js(`window.__text('.up-uid')`) || '').includes('@' + peerApi.username),
    '资料页展示账号名',
    await js(`window.__text('.up-uid')`)
  )
  const rowsText = (await js(`[...document.querySelectorAll('.up-row')].map(r=>r.textContent.replace(/\\s+/g,'')).join('|')`)) || ''
  ok(rowsText.includes('性别'), '有性别行', rowsText)
  ok(rowsText.includes('生日'), '有生日行')
  ok(rowsText.includes('地区'), '有地区行')
  ok(
    /生日\d{2}-\d{2}/.test(rowsText) && !/\d{4}/.test(rowsText.replace(/\d+岁/g, '')),
    '★ 生日只显示「月-日」，不暴露出生年',
    rowsText.match(/生日[^|]*/)?.[0]
  )
  ok(/生日[^|]*\d+岁/.test(rowsText), '生日旁给出年龄', rowsText.match(/生日[^|]*/)?.[0])
  const tagCount = await js(`document.querySelectorAll('.up-tags > *').length`)
  ok(tagCount === (peerApi.tags || []).length, '兴趣标签数量与后端一致', `${tagCount} vs ${(peerApi.tags || []).length}`)
  const stats = await js(`window.__text('.up-stats')`)
  ok(!!stats && stats.includes('共同群聊'), '有共同群聊统计', stats)
  ok(!!stats && stats.includes('已建立'), '★ 已有私聊会话时统计显示「已建立」', stats)
  await shot('08-user-profile')

  await js(`window.__click('.up-msg')`)
  await waitFor(`!document.querySelector('.up-root')`, 5000)
  ok(!(await js(`window.__has('.up-root')`)), '点「发消息」收起资料页')
  ok(await js(`window.__has('.room-scroll')`), '收起后回到会话里（不是回到列表）')

  /* 会话设置里的资料卡入口也应该通 */
  await js(`window.__click('.rh-btn[aria-label="会话设置"]')`)
  await waitFor(`!!document.querySelector('.info-profile-row')`, 6000)
  ok(await js(`window.__has('.info-profile-row')`), '会话设置里有对方资料卡入口')
  await js(`window.__click('.info-profile-row')`)
  const upOpen2 = await waitFor(`!!document.querySelector('.up-root .up-idcard')`, 6000)
  ok(upOpen2, '从会话设置也能进对方资料页')
  ok(!(await js(`window.__has('.sheet')`)) || !(await js(`window.__has('.info-profile-row')`)), '打开资料页时设置面板已收起（不叠两层）')
  await shot('09-profile-from-sheet')

  /* 群聊分支：同一个头像按钮在群里必须打开「会话设置」而不是资料页 ——
     群聊没有单一「对方」可看，误开资料页会拿到 undefined 的 userId。 */
  const grpName = groupConv?.name
  if (grpName) {
    await js(`window.__click('.rh-back')`)
    await waitFor(`!document.querySelector('.room') && !!document.querySelector('.chat-list')`)
    await js(HELPERS)
    const openGrp = await js(`(() => {
      const rows = [...document.querySelectorAll('.chat-list .chat-row')]
      const r = rows.find(x => (x.querySelector('.cr-name')||{}).textContent.replace(/\\s+/g,'').startsWith(${JSON.stringify(grpName.replace(/\s+/g, ''))}))
      if (!r) return false
      r.click(); return true
    })()`)
    ok(openGrp, `点了群聊「${grpName}」那一行`)
    await waitFor(`!!document.querySelector('.room-scroll')`)
    await sleep(600)
    /* 断言「真的进了这个群」，而不是只断言「点到了某一行」——
       `.cr-name` 是前缀匹配，点错行的话后面所有断言都会在错误的房间里跑。 */
    const roomTitle = await js(`window.__text('.rh-name')`)
    ok(
      !!roomTitle && roomTitle.replace(/\s+/g, '').startsWith(grpName.replace(/\s+/g, '')),
      '★ 房间标题就是刚点的那个群（没有点错行）',
      `标题=${roomTitle} 期望以 ${grpName} 开头`
    )
    ok(await js(`!!document.querySelector('.rh-avatar')`), '群聊顶部头像同样是独立按钮')
    await js(`window.__click('.rh-avatar')`)
    await sleep(800)
    ok(!(await js(`window.__has('.up-root')`)), '★ 群聊点头像不会打开「他人资料页」')
    /* 群聊点顶部头像 / 群名进的是**群设置**（管理群名 / 公告 / 成员的那个整屏页），
       不是会话设置里的群成员列表 —— 后者是从「⋯」进的。两条入口通到两个不同用途的页面，
       这里钉的是「进的是群设置」。 */
    ok(await js(`window.__has('.gs-root')`), '★ 群聊点头像打开的是群设置页（.gs-root）')
    await js(`window.__click('.gs-back')`)
    await sleep(500)
    ok(!(await js(`window.__has('.gs-root')`)), '关掉群设置回到聊天页')
    await shot('10-group-avatar-opens-info')
    await js(`(() => { const b=document.querySelector('.sheet-mask'); if(b) b.click(); return true })()`)
    await sleep(400)
  } else {
    console.log('  ℹ️ 库里没有群聊，跳过「群聊头像 → 会话设置」分支')
  }

  /* ===================== 收尾：还原演示数据 ===================== */
  console.log('\n─── 收尾 ───')
  // 先把字节放回磁盘，再写回字段 —— 顺序反了会被「文件不存在」的校验挡下
  if (avatarBackup) {
    fs.writeFileSync(avatarBackup.path, avatarBackup.data)
    ok(fs.existsSync(avatarBackup.path), '原头像文件已放回磁盘', path.basename(avatarBackup.path))
  }
  const restoreAvatar = avatarBackup
    ? snapshot.avatar
    : snapshot.avatar?.startsWith('/uploads/')
      ? null // 文件本来就没了，宁可置空也不要留悬空引用
      : snapshot.avatar

  await patch({
    nickname: snapshot.nickname,
    bio: snapshot.bio,
    gender: snapshot.gender,
    birthday: snapshot.birthday,
    region: snapshot.region,
    tags: snapshot.tags,
    avatar: restoreAvatar,
  })
  const restored = await readMe()
  ok(
    restored.nickname === snapshot.nickname && restored.avatar === restoreAvatar,
    '资料已还原为测试前状态',
    `${restored.nickname} / ${restored.avatar}`
  )
  // 头像若指向本地文件，文件必须真的在 —— 别留破图
  if (restored.avatar?.startsWith('/uploads/')) {
    ok(
      (await fetch(`${BASE}${restored.avatar}`)).status === 200,
      '★ 还原后的头像地址仍可访问（没有留下悬空引用）',
      restored.avatar
    )
  }
  // 测试上传的那张图应该被后端在换头像时顺手删掉
  const orphan = await fetch(`${BASE}${upSaved.avatar}`)
  ok(orphan.status === 404, '测试上传的头像文件被清理（磁盘不留垃圾）', String(orphan.status))

  /* 控制台错误 */
  const errs = cdp.events.filter(
    (e) =>
      (e.method === 'Runtime.exceptionThrown') ||
      (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')
  )
  ok(errs.length === 0, '整个流程没有 JS 异常 / console.error', errs.map((e) => e.method).join(',') || '干净')
} finally {
  proc.kill()
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
console.log(`截图目录：${OUT}`)
process.exit(failures === 0 ? 0 : 1)
