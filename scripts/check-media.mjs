/**
 * 图片 / 视频消息 —— 打开后的「保存 / 关闭 / 播放」端到端验证
 *
 * 这个文件存在的理由是：查看器曾经只是一个光秃秃的 `<img>`，
 * 点开就出不来（只能靠再点一次触发它的元素关掉），也没有任何保存入口。
 * 所以每条断言都找**可观测的证据**，而不是「数一数元素个数 > 0」：
 *   - 关闭：点完查看器真的从 DOM 消失
 *   - 保存：用 CDP 指定下载目录，点完**真的有一个文件落到磁盘上**
 *     （只断言「按钮存在」是最典型的假绿 —— 按钮在但点了没反应也过）
 *   - 播放：`<video>` 的 duration > 0 说明元数据解出来了（文件可解码），
 *     再 `play()` 之后 `!paused` 说明真的在播
 *   - 视频兼容：历史上没有视频入口时视频是以「文件」发出去的（kind='file'），
 *     这条也要能播 —— 否则用户以前发的视频点开还是死的
 *
 * 跑法：node scripts/check-media.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  freePort,
  waitAppTarget,
  connectCdp,
  launchChrome,
  shoot,
} from './lib/cdp.mjs'
import { purgeMessagesAfter, purgeOrphanUploads, maxMessageId } from './lib/debris.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/media'
const PROFILE_DIR = 'D:/BS-chat-os/.tmp/chrome-media'
const DL_DIR = 'D:/BS-chat-os/.tmp/_dl'
const FIXTURES = 'D:/BS-chat-os/.tmp/fixtures'
const PASS = 'chatly123'
const PEER = '林小夏'

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(PROFILE_DIR, { recursive: true })
fs.rmSync(DL_DIR, { recursive: true, force: true })
fs.mkdirSync(DL_DIR, { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 1. 后端：造一条图片消息和一条视频消息 ================= */
const msgBaseline = await maxMessageId()

const me = await (
  await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'chenmo', password: PASS }),
  })
).json()
const auth = { Authorization: `Bearer ${me.token}` }
const convs = (await (await fetch(`${API}/conversations`, { headers: auth })).json()).conversations
/* ⚠️ 会话列表返回的字段是 `name`，**没有** `title`（那是 conversations 表里的列名）。
   按 `title` 找永远找不到 → 静默落到 convs[0]，消息就发进了另一个会话，
   界面上一条都看不到，报出来的却是「图片消息渲染成图片气泡」这种莫名其妙的错。
   之所以以前没暴露：那会儿 convs[0] 恰好就是林小夏那条（按最近活跃排序）。 */
const conv = convs.find((c) => `${c.name || c.title || ''}`.includes(PEER)) || convs[0]

async function sendFile(file, kind) {
  const buf = fs.readFileSync(file)
  const fd = new FormData()
  fd.append('file', new Blob([buf]), path.basename(file))
  /* 上传接口挂在 /api/v1/messages 下（不是 /api/v1/upload）——
     路径写错会拿到 404，而 404 的响应体是 {"error":"接口不存在"}，
     后面 sendFile 报的却是「缺少文件地址」，根因看着完全不挨着。 */
  const up = await (
    await fetch(`${API}/messages/upload`, { method: 'POST', headers: auth, body: fd })
  ).json()
  if (!up.url) throw new Error(`上传失败：${JSON.stringify(up)}`)
  const r = await fetch(`${API}/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: conv.id,
      kind,
      fileUrl: up.url,
      fileName: up.fileName,
      fileSize: up.fileSize,
    }),
  })
  if (!r.ok) throw new Error(`发送 ${kind} 失败：${r.status} ${(await r.json()).error || ''}`)
  return (await r.json()).message
}

const imgMsg = await sendFile(path.join(FIXTURES, 'test.png'), 'image')
/* 故意用 kind='file' 发一条视频：这是「没有视频入口的年代」留下来的形态，
   前端必须按扩展名认出来并当视频处理，否则用户以前发的视频永远播不了。 */
const legacyVideoMsg = await sendFile(path.join(FIXTURES, 'test.mp4'), 'file')
const videoMsg = await sendFile(path.join(FIXTURES, 'test.mp4'), 'video')

console.log(`演示对象：我=陈墨 · 会话「${conv.name || PEER}」#${conv.id}`)
console.log(
  `已造消息：图片 #${imgMsg.id} / 视频(kind=video) #${videoMsg.id} / 视频(kind=file 兼容) #${legacyVideoMsg.id}\n`
)

/* ================= 2. 浏览器 ================= */
const port = await freePort()
const proc = launchChrome({ url: APP, port, profileDir: PROFILE_DIR })
const target = await waitAppTarget(port, APP_HOST)

/* 顺手收控制台：查看器是新 UI，最容易出的是 React 的非法 DOM 嵌套警告
   （比如把带 controls 的 <video> 塞进 <button> 里，那是 interactive content 套 interactive content）。 */
const consoleIssues = []
const downloads = []
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Browser.downloadWillBegin' || e.method === 'Browser.downloadProgress') downloads.push(e.params)
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    const text = (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    consoleIssues.push(`${e.params.type}: ${text}`.slice(0, 200))
  }
  if (e.method === 'Runtime.exceptionThrown') {
    consoleIssues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 200))
  }
  if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
    consoleIssues.push(`${e.params.entry.level}: ${e.params.entry.text}`.slice(0, 200))
  }
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
/* 保存要落到磁盘才算数 —— 不然「按钮存在但点了没反应」也能通过。
   ⚠️ downloadPath 必须是 **Windows 反斜杠**路径：给 `D:/a/b` 这种正斜杠，
   Chrome 会把下载走到一半再 cancel（文件字节都收完了，末态就是 canceled），
   目录里却什么都没有 —— 只看「下载事件触发过」会误判成功能正常。 */
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: DL_DIR.replace(/\//g, '\\'),
  eventsEnabled: true,
})

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
  return r.result.value
}
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await js(expr)) return true
    await sleep(250)
  }
  return false
}

const HELPERS = `
window.__has = (s) => !!document.querySelector(s)
window.__click = (s) => { const e=document.querySelector(s); if(!e) return false; e.click(); return true }
window.__clickText = (sel, txt) => {
  const e=[...document.querySelectorAll(sel)].find(x=>x.textContent.trim()===txt)
  if(!e) return false; e.click(); return true
}
window.__mvBtns = () => [...document.querySelectorAll('.media-viewer .mv-btn')].map(b => b.getAttribute('aria-label'))
window.__openChat = (name) => {
  const r=[...document.querySelectorAll('.chat-list .chat-row')]
    .find(x=>((x.querySelector('.cr-name')||{}).textContent||'').includes(name))
  if(!r) return false; r.click(); return true
}
/* 按消息 id 找到那一行里的元素 —— 用 data 属性比按序号可靠，
   列表顺序会随手插入的消息变化 */
window.__bubbleOf = (id, sel) => {
  const row = document.querySelector('.room-scroll .msg[data-id="' + id + '"]')
  return row ? !!row.querySelector(sel) : false
}
window.__clickBubble = (id, sel) => {
  const row = document.querySelector('.room-scroll .msg[data-id="' + id + '"]')
  if (!row) return false
  const el = row.querySelector(sel)
  if (!el) return false
  el.click(); return true
}
window.__vbGeo = (id) => {
  const row = document.querySelector('.room-scroll .msg[data-id="' + id + '"]')
  if (!row) return null
  const v = row.querySelector('.vb-media')
  const r = v.getBoundingClientRect()
  const dur = row.querySelector('.vb-dur')
  return {
    vw: v.videoWidth, vh: v.videoHeight,
    w: Math.round(r.width), h: Math.round(r.height),
    hasPlay: !!row.querySelector('.vb-play'),
    dur: dur ? dur.textContent.trim() : null,
  }
}
window.__mediaInfo = () => {
  const v = document.querySelector('.media-viewer video')
  const i = document.querySelector('.media-viewer img')
  const el = v || i
  if (!el) return null
  return {
    tag: v ? 'video' : 'img',
    src: el.getAttribute('src') ? new URL(el.getAttribute('src'), location.href).pathname : '',
    controls: v ? v.hasAttribute('controls') : null,
    duration: v ? v.duration : null,
    videoWidth: v ? v.videoWidth : null,
    w: Math.round(el.getBoundingClientRect().width),
    h: Math.round(el.getBoundingClientRect().height),
  }
}
window.__play = () => {
  const v = document.querySelector('.media-viewer video')
  if (!v) return null
  v.play()
  return true
}
window.__playing = () => {
  const v = document.querySelector('.media-viewer video')
  return v ? { paused: v.paused, t: v.currentTime, dur: v.duration } : null
}
`

try {
  /* ---- 登录并进入会话 ---- */
  await cdp.send('Page.navigate', { url: APP })
  await waitFor(`location.origin === ${JSON.stringify(APP_HOST)}`)
  await js(HELPERS)
  /* The fixed test profile can contain a revoked token from earlier suites. */
  await js(`localStorage.removeItem('chatly.token')`)
  await cdp.send('Page.reload')
  const booted = await waitFor(
    `!!document.querySelector('.lg-demo-list button') || !!document.querySelector('.chat-list .chat-row')`
  )
  if (!booted) throw new Error('应用没挂载')
  if (await js(`!!document.querySelector('.lg-demo-list button')`)) {
    await js(
      `(() => { const b=[...document.querySelectorAll('.lg-demo-list button')].find(x=>x.textContent.includes('陈墨')); if(b) b.click(); return !!b })()`
    )
    await waitFor(`!!document.querySelector('.tabbar') && !!document.querySelector('.chat-list .chat-row')`, 15000)
  }
  await js(HELPERS)
  const peerReady = await waitFor(`[...document.querySelectorAll('.chat-list .chat-row')].some(x=>((x.querySelector('.cr-name')||{}).textContent||'').includes(${JSON.stringify(PEER)}))`, 15000)
  if (!peerReady || !(await js(`window.__openChat(${JSON.stringify(PEER)})`))) throw new Error(`会话「${PEER}」未加载或无法打开`)
  if (!(await waitFor(`!!document.querySelector('.room-scroll')`, 15000))) throw new Error('聊天室未打开')
  await sleep(900)
  await js(HELPERS)

  /* ================= A. 图片 ================= */
  console.log('─── A. 图片：点开 / 保存 / 关闭 ───')
  const hasImg = await js(`window.__bubbleOf(${imgMsg.id}, '.img-bubble')`)
  ok(hasImg, '图片消息渲染成图片气泡')

  await js(`window.__clickBubble(${imgMsg.id}, '.img-bubble')`)
  ok(await waitFor(`!!document.querySelector('.media-viewer')`), '点图片打开查看层')

  const btns = await js(`window.__mvBtns()`)
  ok(btns.includes('关闭'), '查看层有关闭按钮', JSON.stringify(btns))
  ok(btns.includes('保存到本地'), '查看层有保存按钮', JSON.stringify(btns))

  const info = await js(`window.__mediaInfo()`)
  ok(info && info.tag === 'img' && info.w > 0, '查看层里渲染的是图片', JSON.stringify(info))
  await shoot(cdp, `${OUT}/01-image-viewer.png`)

  /* 保存需要真实用户手势：部分 Chromium 版本会拒绝脚本 click() 触发 download。 */
  const saveBox = await js(`(() => { const r=document.querySelector('.media-viewer .mv-btn[aria-label="保存到本地"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: saveBox.x, y: saveBox.y, id: 1 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  let file = null
  for (let i = 0; i < 40 && !file; i++) {
    await sleep(250)
    const got = fs.readdirSync(DL_DIR).filter((f) => !f.endsWith('.crdownload'))
    if (got.length) file = got[0]
  }
  ok(!!file, '★ 点保存后文件真的落到了磁盘', file || `（${DL_DIR} 里什么都没有；下载事件 ${JSON.stringify(downloads)}）`)
  if (file) {
    const size = fs.statSync(path.join(DL_DIR, file)).size
    ok(size > 0, '保存下来的文件非空', `${file} ${size} 字节`)
  }
  ok(await js(`!!document.querySelector('.media-viewer')`), '保存后查看层不会被关掉')

  /* 关闭 */
  await js(`window.__click('.media-viewer .mv-btn[aria-label="关闭"]')`)
  await sleep(500)
  ok(!(await js(`!!document.querySelector('.media-viewer')`)), '点关闭后查看层收起')

  /* ================= B. 视频（kind='video'） ================= */
  console.log('\n─── B. 视频：气泡 / 播放 / 关闭 ───')
  ok(
    await js(`window.__bubbleOf(${videoMsg.id}, '.video-bubble')`),
    'kind=video 的消息渲染成视频气泡（不是文件卡片）'
  )
  ok(
    !(await js(`window.__bubbleOf(${videoMsg.id}, '.file-card')`)),
    'kind=video 的消息不再显示成文件卡片'
  )
  /* 几何只能靠几何断言抓（截图目测会被缩放骗）。源是 4:3，
     所以气泡的宽高比也应该接近 4:3 —— 只数「有没有 video 元素」抓不到拉变形。 */
  await waitFor(`(() => { const g=window.__vbGeo(${videoMsg.id}); return !!g && g.vw > 0 })()`, 12000)
  const geo = await js(`window.__vbGeo(${videoMsg.id})`)
  ok(geo && geo.vw > 0, '气泡内视频元数据可用', JSON.stringify(geo))
  const srcRatio = geo && geo.vh ? geo.vw / geo.vh : 0
  const boxRatio = geo && geo.h ? geo.w / geo.h : 0
  ok(
    Math.abs(boxRatio - srcRatio) < 0.06,
    '★ 视频气泡宽高比与源视频一致（没被拉伸/压扁）',
    `源 ${srcRatio.toFixed(2)} vs 盒子 ${boxRatio.toFixed(2)}（${geo?.w}×${geo?.h}）`
  )
  ok(geo && geo.hasPlay, '视频气泡上有播放角标')
  ok(geo && /^\d+:\d{2}$/.test(geo.dur || ''), '视频气泡角标显示时长', geo?.dur)
  await shoot(cdp, `${OUT}/02-video-bubble.png`)

  await js(`window.__clickBubble(${videoMsg.id}, '.video-bubble')`)
  ok(await waitFor(`!!document.querySelector('.media-viewer video')`), '点视频气泡打开查看层并挂上 <video>')
  /* 必须等元数据加载完再断言：刚挂上 <video> 时 duration 是 NaN
     （JSON 序列化成 null）、videoWidth 是 0 —— 这时断言会误判成「文件是坏的」。 */
  const metaOk = await waitFor(
    `(() => { const v=document.querySelector('.media-viewer video'); return !!v && v.readyState >= 1 })()`,
    15000
  )
  ok(metaOk, '视频元数据已加载')

  const vi = await js(`window.__mediaInfo()`)
  ok(vi && vi.tag === 'video', '查看层里是 <video> 而不是 <img>', JSON.stringify(vi?.tag))
  /* ⚠️ 这里改成断言**没有**原生 controls。
     以前原生控件是「能用」的证据，现在它恰恰是要避免的东西：
     原生控件会带出「画中画 / 下载」这些没接的按钮（点了没反应 = 坏功能），
     而且不管容器比例、各浏览器长得都不一样。控制条由我们自己的播放器提供。 */
  ok(vi && vi.controls === false, '★ 视频上没有原生 controls（没接的按钮不会漏出来）', String(vi?.controls))
  const bars = await js(`(() => {
    const b = document.querySelector('.media-viewer .vp-bar')
    if (!b) return null
    return {
      play: !!b.querySelector('.vp-ic[aria-label="播放"], .vp-ic[aria-label="暂停"]'),
      track: !!b.querySelector('.vp-track'),
      mute: !!b.querySelector('.vp-ic[aria-label="静音"], .vp-ic[aria-label="取消静音"]'),
      full: !!b.querySelector('.vp-ic[aria-label="全屏"], .vp-ic[aria-label="退出全屏"]'),
      time: !!b.querySelector('.vp-time'),
    }
  })()`)
  ok(
    bars && bars.play && bars.track && bars.mute && bars.full && bars.time,
    '★ 查看器用的是自建控制条（播放 / 进度 / 时间 / 静音 / 全屏）',
    JSON.stringify(bars)
  )
  ok(vi && /^\/api\/v1\/files\/private\/.+\.mp4$/.test(vi.src), 'video 的 src 指向成员校验的私有 mp4', vi?.src)
  /* duration > 0 说明元数据解出来了 —— 文件是真能解码的，不是挂了个坏链接 */
  ok(vi && vi.duration > 0, '★ 视频元数据可读（文件可解码）', `duration=${vi?.duration}`)
  ok(vi && vi.videoWidth > 0, '视频有真实画面尺寸', `${vi?.videoWidth}px 宽`)

  await js(`window.__play()`)
  await sleep(1200)
  const playing = await js(`window.__playing()`)
  ok(playing && !playing.paused, '★ 调用 play() 后视频真的在播', JSON.stringify(playing))
  ok(playing && playing.t > 0, '播放进度在推进', `currentTime=${playing?.t?.toFixed?.(2)}`)
  await shoot(cdp, `${OUT}/03-video-playing.png`)

  await js(`window.__click('.media-viewer .mv-btn[aria-label="关闭"]')`)
  await sleep(400)
  ok(!(await js(`!!document.querySelector('.media-viewer')`)), '视频查看层可关闭')

  /* ================= C. 兼容：以「文件」形态发的老视频 ================= */
  console.log('\n─── C. 兼容：以「文件」形态发出的视频 ───')
  ok(
    await js(`window.__bubbleOf(${legacyVideoMsg.id}, '.video-bubble')`),
    '★ kind=file 但扩展名是视频 → 也按视频渲染（历史消息能播）'
  )
  await js(`window.__clickBubble(${legacyVideoMsg.id}, '.video-bubble')`)
  ok(await waitFor(`!!document.querySelector('.media-viewer video')`), '历史视频也能打开查看层')
  await waitFor(
    `(() => { const v=document.querySelector('.media-viewer video'); return !!v && v.readyState >= 1 })()`,
    15000
  )
  const li = await js(`window.__mediaInfo()`)
  ok(li && li.tag === 'video' && li.duration > 0, '历史视频同样可解码', JSON.stringify(li?.duration))
  await js(`window.__click('.media-viewer .mv-btn[aria-label="关闭"]')`)
  await sleep(400)

  /* ================= D. 回归 ================= */
  console.log('\n─── D. 回归 ───')
  const ov = await js(`(() => { const de=document.documentElement; return { sw: de.scrollWidth, cw: de.clientWidth } })()`)
  ok(ov.sw <= ov.cw + 1, '消息列表无横向溢出', `${ov.sw} / ${ov.cw}`)
  ok(await js(`!!document.querySelector('.composer')`), '输入区仍在')
  /* 404 也要算进来：素材地址写错时页面不报错，只是静静显示破图 */
  const notFound = consoleIssues.filter((s) => /404|Failed to load/i.test(s))
  ok(notFound.length === 0, '没有资源 404', notFound.join(' | ').slice(0, 160))
  ok(consoleIssues.length === 0, '查看器打开/播放/保存全程无控制台报错', consoleIssues.join(' | ').slice(0, 200))

  /* ================= E. 发送入口 ================= */
  console.log('\n─── E. 视频发送入口 ───')
  await js(`window.__click('.composer .cp-btn[aria-label="更多"]')`)
  ok(await waitFor(`!!document.querySelector('.plus-panel')`), '加号面板打开')
  const items = await js(
    `[...document.querySelectorAll('.plus-item')].map(b => ({ t: b.textContent.trim(), off: b.disabled }))`
  )
  const videoItem = (items || []).find((i) => i.t.startsWith('视频'))
  ok(!!videoItem, '加号面板里有「视频」入口', JSON.stringify((items || []).map((i) => i.t)))
  /* 本项目明确不做假功能：入口要么真能用，要么置灰标「未接入」。
     只断言「按钮存在」的话，加一个永远置灰的按钮也能过。 */
  ok(videoItem && !videoItem.off, '★ 「视频」是真能用的入口（不是置灰的假按钮）')
  ok(!/未接入/.test(videoItem?.t || ''), '「视频」没有标成未接入', videoItem?.t)
  await shoot(cdp, `${OUT}/04-plus-sheet.png`)
  await js(`window.__click('.plus-mask')`)
  await sleep(400)

  console.log(`\n${failures === 0 ? '🎉 全部通过' : `❌ ${failures} 条失败`}`)
  console.log(`截图目录：${OUT}`)
} catch (e) {
  console.error('\n💥 脚本异常:', e.message)
  failures++
} finally {
  try {
    await cdp.close()
  } catch {}
  proc.kill()
  const gone = await purgeMessagesAfter(msgBaseline)
  if (gone) console.log(`已清理自检发出的 ${gone} 条消息`)
  /* ⚠️ 顺序不能反：先删消息，再收文件。
     反过来会把「刚上传、消息还指着」的文件当成孤儿挪走，
     那条消息就变成破图了。 */
  await purgeOrphanUploads()
  process.exit(failures ? 1 : 0)
}
