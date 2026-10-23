/**
 * 已读回执校验：小头像簇 + 已读详情弹层
 *
 * 为什么两个场景都用「每轮重建的全新小组」：
 *   回执数据是全局实时的。如果拿一个常驻会话（比如「设计部」）做探针，
 *   只要有任何真实客户端正开着那个房间，新消息一到就会被对端自动补已读
 *   （src/store/ChatStore.jsx 里 raw.conversationId === activeConvId 就 markRead），
 *   于是「刚发出 → 必然全未读」这条断言先天不可测。
 *   全新小组不可能被别的客户端打开，成员又全选离线用户，才拿得到确定性快照。
 *
 * 场景：
 *   A. 回执演示·部分（除我外 3 人，全离线）—— 发出后必然「未读」，3 个头像全灰；
 *      触发 1 人已读 → 实时变「1/3 已读」，读到的人排前面且不置灰；点开逐人列出。
 *   B. 回执演示·收纳（除我外 5 人）—— 只露 3 个头像 + 「+2」；点开能看到全部 5 人。
 *   C. 回执演示·翻转（一次性，跑完即删）—— 压矮视口并滚到顶，让收据落进内容区最上方，
 *      验证弹层会改为「向下弹」且不被裁掉（需求原文要求「向下或者向上弹出」）。
 *
 *   node scripts/check-readreceipt.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL as NodeURL } from 'node:url'
import { purgeDebris } from './lib/debris.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:3002/api/v1'
const APP = 'http://127.0.0.1:5198/'
const PORT = 9451
const OUT = 'D:/BS-chat-os/shots/readreceipt'
const PASS = 'chatly123'

const GROUP_A = '回执演示·部分'
const GROUP_B = '回执演示·收纳'
const GROUP_C = '回执演示·翻转' // 只用于几何验证，跑完即删
/* 上一版脚本留下的「收件人小组」不在这里单独清了 —— 三个「回执演示·*」小组和它
   一起交给 scripts/lib/debris.mjs 按前缀统一处理，开头清旧、结尾清本轮。 */

/* 全离线成员 —— 没有任何客户端能自动补已读，断言才是确定的 */
const OFFLINE_A = ['xiaolu', 'chenyu', 'xiatian']
const OFFLINE_B = ['linxiaoxia', 'ajie', 'xiaolu', 'chenyu', 'xiatian']

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(path.join('D:/BS-chat-os/.tmp/chrome-rr'), { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 后端数据准备（走真实 API） ================= */
async function login(username) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  if (!r.ok) throw new Error(`login ${username} failed ${r.status}`)
  return r.json()
}

async function apiCall(token, p, init = {}) {
  const r = await fetch(`${API}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const me = await login('chenmo')
const others = {}
for (const u of OFFLINE_B) others[u] = await login(u)
console.log(`已登录：陈墨#${me.user.id} + ${OFFLINE_B.length} 位成员`)

/** 删掉同名旧小组再新建 —— 保证所有成员游标都从 0 开始，可重复运行 */
async function ensureGroup(title, usernames) {
  const convs = (await apiCall(me.token, '/conversations')).body.conversations
  const old = convs.find((c) => c.type === 'group' && c.name === title)
  if (old) await apiCall(me.token, `/conversations/${old.id}`, { method: 'DELETE' })
  const memberIds = usernames.map((u) => others[u].user.id)
  const created = await apiCall(me.token, '/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'group', title, memberIds }),
  })
  const id = created.body.conversationId
  if (!id) throw new Error(`创建「${title}」失败：${JSON.stringify(created.body)}`)
  return { id, name: title, peers: usernames.length }
}

/* 先把历次自检攒下的残留清干净。
   ⚠️ 上面 ensureGroup 里的 `DELETE /conversations/:id` **删不掉会话** ——
   那个接口的语义是「退出成员关系」，会话行、消息、其他成员的成员记录全都留着。
   所以每跑一轮就多留一批同名孤儿，「回执演示·部分」一度攒到 13 个。
   真要清只能从这里直接删库（见 scripts/lib/debris.mjs）。 */
{
  const r = await purgeDebris({ quiet: true })
  if (r.conversations) console.log(`已清理历次自检残留：${r.conversations} 个会话 / ${r.messages} 条消息`)
}

const ga = await ensureGroup(GROUP_A, OFFLINE_A)
const gb = await ensureGroup(GROUP_B, OFFLINE_B)
const gc = await ensureGroup(GROUP_C, OFFLINE_B)
console.log(`已重建「${GROUP_A}」#${ga.id}（我 + ${ga.peers} 人）`)
console.log(`已重建「${GROUP_B}」#${gb.id}（我 + ${gb.peers} 人）`)
console.log(`已重建「${GROUP_C}」#${gc.id}（我 + ${gc.peers} 人，用于验证「向下弹」）`)

/** 以陈墨身份直接灌一条消息（走真实接口，省掉 UI 输入的开销） */
async function sendAsMe(convId, text) {
  const r = await apiCall(me.token, '/messages', {
    method: 'POST',
    body: JSON.stringify({ conversationId: convId, kind: 'text', text }),
  })
  if (!r.body.message?.id) throw new Error(`灌消息失败：${JSON.stringify(r.body)}`)
  return r.body.message
}

/* 场景 C 需要「内容溢出 → 滚到顶 → 收据落在内容区最上方」，
   所以先灌够条数，让短视口下必然出现滚动条。 */
const seededC = []
for (let i = 1; i <= 6; i++) seededC.push(await sendAsMe(gc.id, `翻转探针 ${i}`))
console.log(`「${GROUP_C}」已灌入 ${seededC.length} 条我方消息（id ${seededC[0].id}–${seededC[seededC.length - 1].id}）`)

/* ================= CDP ================= */
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
  throw new Error('chrome not ready')
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

const proc = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=D:/BS-chat-os/.tmp/chrome-rr',
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
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
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

const HELPERS = `
window.__rowByName = (name) => [...document.querySelectorAll('.chat-list .chat-row')].find(x => {
  const n = x.querySelector('.cr-name'); return n && n.textContent.replace(/\\s+/g,'').startsWith(name)
}) || null
window.__openChat = (name) => { const r = window.__rowByName(name); if (!r) return false; r.click(); return true }
window.__type = (sel, val) => {
  const el = document.querySelector(sel); if (!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
  el.dispatchEvent(new Event('input', { bubbles: true })); return true
}
window.__click = (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true }
window.__send = (text) => {
  const el = document.querySelector('.composer textarea'); if (!el) return false
  const proto = HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
/* 找到含指定文本的「我方消息」行 */
window.__myRow = (text) => {
  const rows = [...document.querySelectorAll('.room-scroll .msg.is-mine')]
  return [...rows].reverse().find(r => r.textContent.includes(text)) || null
}
/* 一次读全：标签文案 + 头像总数 + 置灰数 + 逐个置灰位序（同一快照，自洽） */
window.__receipt = (text) => {
  const row = window.__myRow(text); if (!row) return null
  const tag = row.querySelector('.read-tag'); if (!tag) return null
  const avs = [...tag.querySelectorAll('.rt-av')]
  return {
    label: tag.querySelector('.rt-label')?.textContent.trim() || '',
    avatars: avs.length,
    dim: avs.filter(a => a.classList.contains('is-unread')).length,
    dims: avs.map(a => a.classList.contains('is-unread')),
    more: tag.querySelector('.rt-more')?.textContent.trim() || null,
  }
}
window.__clickReceipt = (text) => {
  const row = window.__myRow(text); if (!row) return false
  const tag = row.querySelector('.read-tag'); if (!tag) return false
  tag.click(); return true
}
window.__pop = () => {
  const pop = document.querySelector('.read-pop'); if (!pop) return null
  const r = pop.getBoundingClientRect()
  const room = document.querySelector('.room').getBoundingClientRect()
  const comp = document.querySelector('.composer')
  const cr = comp ? comp.getBoundingClientRect() : null
  return {
    head: pop.querySelector('.rp-head')?.textContent.replace(/\\s+/g,' ').trim() || '',
    rows: [...pop.querySelectorAll('.rp-row')].map(x => ({
      name: x.querySelector('.rp-name')?.textContent.trim() || '',
      tag: x.querySelector('.rp-tag')?.textContent.trim() || '',
      pending: x.classList.contains('is-pending'),
    })),
    // 弹层必须完整落在内容区里（不能太大 / 不能被裁）
    inside: r.left >= room.left - 1 && r.right <= room.right + 1 && r.top >= room.top - 1 && r.bottom <= room.bottom + 1,
    // 也不能压住输入区（矮屏下向下弹最容易犯）
    coversComposer: cr ? r.bottom > cr.top + 1 : false,
    width: Math.round(r.width),
    height: Math.round(r.height),
    top: Math.round(r.top - room.top),
    bottom: Math.round(r.bottom - room.top),
  }
}
/* 第一条带收据的我方消息 —— 用于「滚到顶 → 上方空间不足 → 应改为向下弹」 */
window.__firstReceipt = () => {
  const room = document.querySelector('.room').getBoundingClientRect()
  for (const r of document.querySelectorAll('.room-scroll .msg.is-mine')) {
    const tag = r.querySelector('.read-tag')
    if (!tag) continue
    const tr = tag.getBoundingClientRect()
    return { tagTop: Math.round(tr.top - room.top), tagBottom: Math.round(tr.bottom - room.top) }
  }
  return null
}
window.__clickFirstReceipt = () => {
  for (const r of document.querySelectorAll('.room-scroll .msg.is-mine')) {
    const tag = r.querySelector('.read-tag')
    if (tag) { tag.click(); return true }
  }
  return false
}
`

/** 解析「3/5 已读」这类标签 */
function parseLabel(label) {
  if (!label) return { read: null, total: null }
  if (label === '未读') return { read: 0, total: null }
  const m = /^(\d+)\/(\d+) 已读$/.exec(label)
  return m ? { read: Number(m[1]), total: Number(m[2]) } : { read: null, total: null }
}

/** 发一条探针消息并等它落到 DOM */
async function sendProbe(text) {
  await js(`window.__send(${JSON.stringify(text)})`)
  await waitFor(`!!document.querySelector('.cp-send')`)
  await js(`window.__click('.cp-send')`)
  return waitFor(`!!window.__myRow(${JSON.stringify(text)})`)
}

try {
  await waitFor(`!!document.querySelector('.lg-card, .login')`)
  // 保证每次都从登录页开始；已有登录态会直接进主页
  try {
    await cdp.send('Runtime.evaluate', { expression: 'localStorage.clear()' })
  } catch {}
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1500)
  await waitFor(`!!document.querySelector('.lg-card, .login')`)
  await js(HELPERS)
  await ensureLoggedIn(js)
  await waitFor(`!!document.querySelector('.chat-list .chat-row')`)
  await js(HELPERS)

  /* ============ 场景 A：回执演示·部分（3 人，全离线）============ */
  console.log(`\n─── 场景 A：${GROUP_A}（除我外 ${ga.peers} 人，全离线）───`)
  ok(await js(`window.__openChat(${JSON.stringify(GROUP_A)})`), `打开了「${GROUP_A}」`)
  await waitFor(`!!document.querySelector('.composer textarea') && !document.querySelector('.composer textarea').disabled`)

  const tA = `回执探针A-${Date.now()}`
  ok(!!(await sendProbe(tA)), '探针消息已发出')

  const rA0 = await waitFor(`(() => { const v = window.__receipt(${JSON.stringify(tA)}); return v || null })()`)
  ok(rA0?.label === '未读', '刚发出时显示「未读」', `label=${rA0?.label} 头像${rA0?.avatars} 置灰${rA0?.dim}`)
  ok(rA0?.avatars === 3 && rA0?.dim === 3, '3 人全未读 → 3 个头像全部置灰', `${rA0?.avatars}/${rA0?.dim}`)

  // 小鹿读一下 → 应经 WS 实时反映到正在开的房间
  await apiCall(others.xiaolu.token, `/conversations/${ga.id}/read`, { method: 'POST' })
  const rA1 = await waitFor(
    `(() => { const v = window.__receipt(${JSON.stringify(tA)}); return v && v.label !== '未读' ? v : null })()`
  )
  const la = parseLabel(rA1?.label)
  ok(la.total === 3 && la.read === 1, '1 人读后实时变为「1/3 已读」', `label=${rA1?.label}`)
  ok(rA1?.avatars === 3 && rA1?.dim === 3 - la.read, '置灰头像数 = 未读人数（同一快照自洽）', `置灰${rA1?.dim} 未读${3 - la.read}`)
  ok(
    rA1?.dims?.[0] === false && rA1?.dims?.[1] === true,
    '读到的人排在最前且不置灰，没读的置灰在后',
    `dims=${JSON.stringify(rA1?.dims)}`
  )

  await shot('01-A-partial')
  await js(`window.__clickReceipt(${JSON.stringify(tA)})`)
  const popA = await waitFor(`window.__pop()`)
  ok(!!popA, '点击已读弹出详情')
  ok(popA?.rows.length === 3, '详情列出全部 3 人', `${popA?.rows.length} 行`)

  const headReadA = Number(/已读\s*(\d+)/.exec(popA?.head || '')?.[1])
  const rowsReadA = popA?.rows.filter((r) => !r.pending).length || 0
  const rowsUnreadA = popA?.rows.filter((r) => r.pending).length || 0
  ok(headReadA === rowsReadA, '标题已读数与列表中的已读行一致', `标题${headReadA} 列表${rowsReadA}`)
  ok(rowsReadA + rowsUnreadA === 3, '已读 + 未读 = 总人数', `${rowsReadA}+${rowsUnreadA}`)
  ok(rowsReadA === 1, '恰好 1 人已读（与触发的读取一致）', `已读${rowsReadA}`)
  const xiaoluRowA = popA?.rows.find((r) => r.name === '小鹿')
  ok(!!xiaoluRowA && !xiaoluRowA.pending, '小鹿（本次触发已读的人）标记为已读', xiaoluRowA?.tag)
  ok(popA?.rows[popA.rows.length - 1]?.pending === true, '未读的人排在列表末尾', popA?.rows.map((r) => r.name).join('>'))
  ok(!!popA?.inside, '弹层完整落在内容区内（无溢出）', `${popA?.width}×${popA?.height}`)
  ok(!popA?.coversComposer, '弹层不压住输入区', `bottom=${popA?.bottom}`)
  await shot('02-A-popover')

  await js(`window.__click('.read-pop-mask')`)
  ok(!(await js(`!!document.querySelector('.read-pop')`)), '点击遮罩关闭弹层')

  /* ============ 场景 B：回执演示·收纳（5 人）—— 收纳成 +N ============ */
  console.log(`\n─── 场景 B：${GROUP_B}（除我外 ${gb.peers} 人）───`)
  await js(`window.__click('.rh-back')`)
  await waitFor(`!document.querySelector('.room') && !!document.querySelector('.chat-list')`)
  js(HELPERS)
  ok(await js(`window.__openChat(${JSON.stringify(GROUP_B)})`), `打开了「${GROUP_B}」`)
  await waitFor(`!!document.querySelector('.composer textarea') && !document.querySelector('.composer textarea').disabled`)

  const tB = `回执探针B-${Date.now()}`
  ok(!!(await sendProbe(tB)), '探针消息已发出')

  const rB0 = await waitFor(`(() => { const v = window.__receipt(${JSON.stringify(tB)}); return v || null })()`)
  ok(rB0?.label === '未读', '刚发出时显示「未读」', `label=${rB0?.label}`)
  ok(rB0?.avatars === 3 && rB0?.more === '+2' && rB0?.dim === 3, '5 人未读 → 只露 3 个头像 + 「+2」', `头像${rB0?.avatars} 更多${rB0?.more} 置灰${rB0?.dim}`)

  // 两个成员各自读一下
  await apiCall(others.xiaolu.token, `/conversations/${gb.id}/read`, { method: 'POST' })
  await apiCall(others.chenyu.token, `/conversations/${gb.id}/read`, { method: 'POST' })

  const rB1 = await waitFor(
    `(() => { const v = window.__receipt(${JSON.stringify(tB)}); return v && v.label.includes('2/5') ? v : null })()`
  )
  const lb = parseLabel(rB1?.label)
  ok(rB1?.label === '2/5 已读', '2 人读后实时变为「2/5 已读」', `label=${rB1?.label}`)
  ok(rB1?.avatars === 3 && rB1?.more === '+2', '仍然只露 3 个头像 + 「+2」（收纳生效）', `头像${rB1?.avatars} 更多${rB1?.more}`)
  ok(
    lb.read === 2 && rB1?.dims?.[0] === false && rB1?.dims?.[1] === false && rB1?.dims?.[2] === true,
    '收纳后仍把已读的排前面（前 2 位亮、第 3 位置灰）',
    `dims=${JSON.stringify(rB1?.dims)}`
  )
  ok(rB1?.dim === Math.max(0, 3 - lb.read), '置灰数 = max(0, 3 - 已读数)', `置灰${rB1?.dim}`)

  await shot('03-B-collapsed')
  await js(`window.__clickReceipt(${JSON.stringify(tB)})`)
  const popB = await waitFor(`window.__pop()`)
  ok(popB?.rows.length === 5, '详情里能看到全部 5 人（点开才展开）', `${popB?.rows.length} 行`)
  const rowsReadB = popB?.rows.filter((r) => !r.pending).length || 0
  const rowsUnreadB = popB?.rows.filter((r) => r.pending).length || 0
  ok(rowsReadB === 2 && rowsUnreadB === 3, '详情 2 已读 / 3 未读，与收纳计数一致', `${rowsReadB}+${rowsUnreadB}`)
  const headReadB = Number(/已读\s*(\d+)/.exec(popB?.head || '')?.[1])
  ok(headReadB === rowsReadB, '标题已读数与列表一致', `标题${headReadB} 列表${rowsReadB}`)
  ok(!!popB?.inside, '弹层仍在内容区内', `${popB?.width}×${popB?.height}`)
  ok(!popB?.coversComposer, '弹层不压住输入区', `bottom=${popB?.bottom}`)
  await shot('04-B-popover')
  await js(`window.__click('.read-pop-mask')`)

  /* ============ 场景 C：收据贴顶 → 必须改为「向下弹」 ============ */
  /* 需求原文是「点击已读向下或者向上弹出」，所以两个方向都要钉住。
     把视口压矮 + 滚到顶，让第一条收据落进内容区最上方（上方空间 < 212px），
     此时若还固执地向上弹就会被裁掉 —— inside 断言会直接抓住。 */
  console.log(`\n─── 场景 C：收据贴顶时改为向下弹（${GROUP_C}）───`)
  await js(`window.__click('.rh-back')`)
  await waitFor(`!document.querySelector('.room') && !!document.querySelector('.chat-list')`)
  await js(HELPERS)
  ok(await js(`window.__openChat(${JSON.stringify(GROUP_C)})`), `打开了「${GROUP_C}」`)

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 420, deviceScaleFactor: 2, mobile: true })
  await waitFor(`!!document.querySelector('.room-scroll .msg.is-mine')`)
  await sleep(500)
  const scrolled = await js(`(() => {
    const s = document.querySelector('.room-scroll'); if (!s) return null
    s.scrollTop = 0
    return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight }
  })()`)
  await sleep(500)
  ok(!!scrolled && scrolled.scrollHeight > scrolled.clientHeight, '内容区可滚动（已滚到顶）', JSON.stringify(scrolled))

  const fr = await js(`window.__firstReceipt()`)
  ok(!!fr && fr.tagTop < 212, '首条收据落在内容区顶部（上方空间不足）', `tagTop=${fr?.tagTop}`)

  await js(`window.__clickFirstReceipt()`)
  const popC = await waitFor(`window.__pop()`)
  ok(!!popC, '贴顶收据仍能点开弹层')
  ok(popC?.top > fr?.tagTop, '弹层改为向下弹（落在收据下方）', `弹层top=${popC?.top} 收据top=${fr?.tagTop}`)
  ok(!!popC?.inside, '向下弹也没有溢出内容区', `${popC?.width}×${popC?.height} bottom=${popC?.bottom}`)
  ok(!popC?.coversComposer, '向下弹时自动收高等教育，不压住输入区', `弹层bottom=${popC?.bottom} 高=${popC?.height}`)
  await shot('05-C-flip-down')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
} finally {
  proc.kill()
}

/* 三个小组都是一次性道具，跑完真删掉，别在演示库里堆孤儿会话。
   想手动体验回执效果的话，跑之前把 --keep 去掉前先看截图，或者自己在 App 里建个群。 */
{
  const r = await purgeDebris({ quiet: true })
  console.log(`\n已清理本次自检残留：${r.conversations} 个会话 / ${r.messages} 条消息`)
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
console.log(`截图目录：${OUT}`)
process.exit(failures === 0 ? 0 : 1)
