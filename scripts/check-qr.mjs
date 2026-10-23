/**
 * 扫一扫 / 我的二维码 专项自检
 *
 * 这个功能**天生容易做成假的**：二维码扫不出来、识别了但不动、按钮点了弹个 toast
 * 说「已添加」其实没落库 —— 界面上全看不出来（码还是那张码，卡片还是那张卡片）。
 * 所以这里的判据一条都不用「元素在不在」：
 *
 *   A. 我的二维码 —— 页面上**真实渲染出来的像素**必须能被解回原文。
 *      两条路都要过：① 页内 canvas 喂回自写解码器；② 截屏成 PNG → Node 侧解 PNG → 解码。
 *      第 ② 条能抓到「canvas 画对了但被 CSS 缩放糊掉」这类只靠 ① 发现不了的问题。
 *      再加上「保存图片下下来的那个文件」也要能解 —— 存了一张废图是最坑的。
 *   B. 扫一扫入口 + 摄像头 —— 用 `--use-fake-device-for-media-stream` 喂一路合成视频，
 *      断言 `videoWidth > 0` 且**解码循环真的在跑**（frames > 0），
 *      同时断言合成画面里没有码时**不误报**。
 *   C. 相册识图 → 加好友 —— 往 file input 塞一张真 PNG，识别后点「加好友」，
 *      然后**回后端查 follows 表**。接口自己说 true 不算。
 *   D/E/F. 自己的码 / 群码 / 纯文本 / 手动输入 —— 四种结果各有各的形态，不能串台。
 *   G. 没有摄像头的环境 —— 必须**写明具体原因**并且相册路径仍然可用，
 *      不能显示一个永远不会动的「正在扫码」。
 *
 * 跑法：node scripts/check-qr.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import { db } from '../server/src/db.js'
import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'
import { purgeDebris } from './lib/debris.mjs'
import { encodeQr, decodeQrImageData } from '../src/lib/qr.js'
import { encodePng, decodePng, qrModulesToRgba } from './lib/png.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/qr'
const DL = 'D:/BS-chat-os/.tmp/qr-downloads'
const PASS = 'chatly123'

/** 识别对象：演示库里和 chenmo 有私聊的人，扫完加好友不会产生「陌生人」脏数据 */
const TARGET = 'linxiaoxia'

fs.mkdirSync(OUT, { recursive: true })
fs.rmSync(DL, { recursive: true, force: true })
fs.mkdirSync(DL, { recursive: true })

let failures = 0
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ================= 后端 ================= */
async function login(username) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  })
  const d = await r.json()
  if (!d.token) throw new Error(`${username} 登录失败：${JSON.stringify(d)}`)
  return { token: d.token, user: d.user, auth: { Authorization: `Bearer ${d.token}` } }
}

const j = async (m, p, body, auth) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(auth || {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  let d
  try {
    d = JSON.parse(t)
  } catch {
    d = t
  }
  return { status: r.status, d }
}

/** 「加好友真的落库了吗」只有这一条能证伪 */
const dbFollows = (a, b) =>
  !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(a, b)

const me = await login('chenmo')
await purgeDebris({ quiet: true })
const targetRes = await j('GET', `/users/by-username/${TARGET}`, null, me.auth)
if (!targetRes.d?.user) throw new Error(`演示库里没有 ${TARGET}，先跑 npm run reset`)
const targetId = targetRes.d.userId
const targetName = targetRes.d.user.nickname

/* 前提归一：加好友的断言要求「一开始没关注」。用户会在预览里随手关注，
   所以这里先取关并记下原状，收尾再还原。 */
const targetHadEdge = dbFollows(me.user.id, targetId)
if (targetHadEdge) await j('DELETE', `/users/${targetId}/follow`, null, me.auth)
ok(!dbFollows(me.user.id, targetId), `关注测试对象「${targetName}」已归一到未关注`, targetHadEdge ? '（原来关注过，收尾还原）' : '')

/* ================= 造测试图 ================= */
/** 把一段文本编成二维码 PNG，落盘；用来喂相册识图 */
function makeQrPng(text, file) {
  const { size, modules } = encodeQr(text, {})
  const img = qrModulesToRgba(modules, size, { scale: 9, margin: 4 })
  fs.writeFileSync(file, encodePng(img.width, img.height, img.data))
  return file
}

/* 这一条同时也是 png.mjs 的自检：编 → 解 → 二维码还能解回来 */
{
  const f = path.join(DL, '_selftest.png')
  makeQrPng('roundtrip-check', f)
  const back = decodePng(fs.readFileSync(f))
  ok(decodeQrImageData(back) === 'roundtrip-check', 'PNG 编解码往返 + 自解码（测试工具自证）')
}

const IMG_TARGET = makeQrPng(`chatly://user/${TARGET}`, path.join(DL, 'in-user.png'))
const IMG_SELF = makeQrPng(`chatly://user/${me.user.username}`, path.join(DL, 'in-self.png'))
const IMG_GROUP = makeQrPng('chatly://group/12', path.join(DL, 'in-group.png'))
const IMG_TEXT = makeQrPng('今天天气不错，出来走走', path.join(DL, 'in-text.png'))

/* ================= 浏览器 ================= */
const port = await freePort()
const profileDir = 'D:/BS-chat-os/.tmp/chrome-qr'
fs.mkdirSync(profileDir, { recursive: true })
/* 合成摄像头：无头环境没有真摄像头，没有这两个开关的话第 B 组只能测到「打不开」，
   等于把「摄像头接线对不对」整个漏掉。 */
const proc = launchChrome({
  url: APP,
  port,
  profileDir,
  extra: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})

const issues = []
/** 最近一次下载请求。下载的**内容**靠它拿（见下面「保存图片」那段的说明） */
let lastDownload = null
const target = await waitAppTarget(port, APP_HOST)
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Page.downloadWillBegin' || e.method === 'Browser.downloadWillBegin') {
    lastDownload = { url: e.params.url, name: e.params.suggestedFilename }
    return
  }
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    const text = (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    issues.push(`${e.params.type}: ${text}`.slice(0, 200))
  }
  if (e.method === 'Runtime.exceptionThrown') {
    issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 300))
  }
  if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
    /* 「查不到的用户 ID」那一步是**故意**打一个 404 的，浏览器会把它记成
       resource error。不排掉的话这条噪音会一直挂着，真问题反而被淹掉。 */
    if (String(e.params.entry.url || '').includes('nobody_zzz_999')) return
    issues.push(`${e.params.entry.level}: ${e.params.entry.text}`.slice(0, 200))
  }
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('DOM.enable')

/* 无头里点「保存图片」不会弹下载框，得显式允许并指定目录，否则下载被静默丢弃 */
try {
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true })
} catch {
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })
}

const js = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
  return r.result.value
}
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await js(expr)) return true
    } catch {
      /* 换 context 时会抛，等下一轮 */
    }
    await sleep(250)
  }
  return false
}

/* ⚠️ 顺序很关键：`waitAppTarget` 只保证 target.url 是应用地址，
   此时 `Runtime.evaluate`（不带 contextId）打的还是**初始 about:blank 那个上下文**。
   在这里注入辅助函数，等真正文档提交后默认上下文一换，函数就全没了 ——
   表现是十几秒后突然报 `window.__tab is not a function`，完全看不出是时序问题。
   所以：**先等应用挂载，再注入**。 */
const HELP = `
window.__tab = (i) => { const t=[...document.querySelectorAll('.tabbar .tab')][i]; if(!t) return false; t.click(); return true }
window.__setInput = (sel, v) => { const i=document.querySelector(sel); if(!i) return false
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
  set.call(i, v); i.dispatchEvent(new Event('input',{bubbles:true})); return true }
window.__btn = (text) => { const b=[...document.querySelectorAll('.scan-btn,.scan-act')].find(x=>x.textContent.trim()===text)
  if(!b) return false; b.click(); return true }
`
const injectHelp = () => js(HELP)

const up = await waitFor(
  `document.readyState !== 'loading' && (!!document.querySelector('.lg-card, .login') || !!document.querySelector('.tabbar'))`,
  30000
)
if (!up) throw new Error('应用没挂载')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(400)
await injectHelp()

/** 真实鼠标事件（视口坐标），先把元素滚到中间 */
const tapAt = async (sel) => {
  const seen = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false
      e.scrollIntoView({ block: 'center' }); return true })()`
  )
  if (!seen) return false
  await sleep(300)
  const box = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null
      const r=e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()`
  )
  if (!box) return false
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
  return true
}

/** 往 file input 里塞一张真实文件（相册那条路径唯一能自动化的入口） */
const injectFile = async (sel, file) => {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })
  if (!nodeId) return false
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId })
  return true
}

/** 截指定元素那块区域，解码回 ImageData（Page.captureScreenshot → PNG → RGBA） */
const decodeRegion = async (sel, { retries = 2 } = {}) => {
  for (let i = 0; i <= retries; i++) {
    const r = await js(
      `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null
        const b=e.getBoundingClientRect()
        return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } })()`
    )
    if (!r || !r.w || !r.h) return null
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 },
    })
    try {
      return decodePng(Buffer.from(shot.data, 'base64'))
    } catch {
      await sleep(300) /* 偶发拿到陈旧帧，重来一次 */
    }
  }
  return null
}

const ctx = { async close() { cdp.close(); proc.kill() } }

/* ================= 上号 ================= */
await ensureLoggedIn(js)
await sleep(700)
await injectHelp()

ok((await js(`window.innerWidth`)) === 390, '视口已按 390×844 移动端覆盖（后续几何断言的前提）')

/* ================= A. 我的二维码 ================= */
console.log('\n─── A. 我的二维码 ───')
await js(`window.__tab(3)`) // 我
await waitFor(`!!document.querySelector('.me-idcard')`, 12000)

ok(
  await js(`!!document.querySelector('.me-idcard [aria-label="我的二维码"]')`),
  '我页 id 卡上有「我的二维码」入口'
)
ok(
  await js(`(() => { const b=document.querySelector('.me-idcard [aria-label="我的二维码"]'); return !!b && b.tagName==='BUTTON' && !b.disabled })()`),
  '入口是真的按钮（不是禁用占位）'
)

/* ★ 两个 32px 圆按钮不能打架。这里必须量**交叠面积 + 命中归属**，不能只断言「两个元素都存在」——
   背景上传按钮被整个盖住时，它照样存在于 DOM、照样是 enabled 的 button，只断言存在性必假绿。
   ⚠️ `.me-idcard` 用 `margin-top:-44px` 上浮压住封面底部 44px，所以「封面右下角」和
   「id 卡右上角」是**同一格**；`.me-idcard` 还有 `z-index:2` 压在封面之上。 */
const clash = await js(`(() => {
  const q = document.querySelector('.me-idcard [aria-label="我的二维码"]')
  const c = document.querySelector('.me-cover-set')
  if (!q || !c) return { err: '缺元素', hasQ: !!q, hasC: !!c }
  const r1 = q.getBoundingClientRect(), r2 = c.getBoundingClientRect()
  const ix = Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left)
  const iy = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top)
  const hitQ = document.elementFromPoint(r1.left + r1.width / 2, r1.top + r1.height / 2)
  const hitC = document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2)
  return {
    overlap: Math.max(0, ix) * Math.max(0, iy),
    qHitsSelf: !!hitQ && q.contains(hitQ),
    cHitsSelf: !!hitC && c.contains(hitC),
    qTop: Math.round(r1.top), cTop: Math.round(r2.top),
  }
})()`)
ok(clash.overlap === 0, '「我的二维码」与「更换主页背景」不重叠', `交叠 ${clash.overlap}px²`)
ok(
  clash.qHitsSelf && clash.cHitsSelf,
  '两个按钮各自中心都能点到自己（没被谁压在下面）',
  `二维码 ${clash.qHitsSelf ? '✓' : '✗'}（y=${clash.qTop}） / 换背景 ${clash.cHitsSelf ? '✓' : '✗'}（y=${clash.cTop}）`
)
await shoot(cdp, `${OUT}/00-me-entry.png`) // 我页入口：二维码在 id 卡右上、换背景在封面上沿，各占一角

await js(`document.querySelector('.me-idcard [aria-label="我的二维码"]').click()`)
ok(await waitFor(`!!document.querySelector('.myqr-canvas')`, 12000), '打开我的二维码页')
ok(
  (await js(`document.querySelector('.sub-head h2')?.textContent.trim()`)) === '我的二维码',
  '页面标题正确'
)

const expectedPayload = `chatly://user/${me.user.username}`
const qrInfo = await js(`(() => { const q = window.__myQr; if(!q) return null
  return { payload:q.payload, version:q.version, size:q.size, canvasWidth:q.canvasWidth, canvasHeight:q.canvasHeight,
           cssWidth: document.querySelector('.myqr-canvas').getBoundingClientRect().width } })()`)
ok(!!qrInfo, '页面暴露了二维码信息（自检钩子）')
ok(qrInfo?.payload === expectedPayload, '负载是 chatly://user/<自己的 ID>', String(qrInfo?.payload))

const selfDecoded = await js(`window.__myQr.decodeSelf()`)
ok(selfDecoded === expectedPayload, '页内 canvas 像素喂回自解码器能解出原文', String(selfDecoded))

ok(
  qrInfo && Math.abs(qrInfo.cssWidth - qrInfo.canvasWidth) < 1.5,
  'canvas 的 CSS 尺寸 = 像素尺寸（没被浏览器缩放糊掉）',
  qrInfo ? `${qrInfo.cssWidth.toFixed(1)} vs ${qrInfo.canvasWidth}` : ''
)

const centering = await js(`(() => {
  const c = document.querySelector('.myqr-canvas').getBoundingClientRect()
  const p = document.querySelector('.myqr-figure').getBoundingClientRect()
  return { left: c.left - p.left, right: p.right - c.right }
})()`)
ok(
  centering && Math.abs(centering.left - centering.right) <= 1.5,
  '码在卡片里水平居中',
  centering ? `左 ${centering.left.toFixed(1)} / 右 ${centering.right.toFixed(1)}` : ''
)
await shoot(cdp, `${OUT}/01-my-qr.png`)

/* 最强的一条：截屏 → 解 PNG → 解码 */
const screenShot = await decodeRegion('.myqr-canvas')
ok(
  screenShot && decodeQrImageData(screenShot) === expectedPayload,
  '截屏成 PNG 再解码 = 原文（屏幕上这张码真的能被扫）',
  screenShot ? `截图 ${screenShot.width}×${screenShot.height}` : '截屏失败'
)

/* 保存图片。
   ⚠️ 这台机器的无头 Chrome **写不了下载文件**：连同一源的直链下载都会走到
   `canceled` 且 `filePath` 为空（已实测三种写法 + 换目录都一样），是环境限制不是产品缺陷。
   所以判据换成两条**更硬**的：
     ① 下载请求本身（文件名对不对）—— 证明 `<a download>` 接线是通的；
     ② 把浏览器实际要保存的那个 blob 的字节读回来解码 —— 证明存下去的是张**能扫的图**，
        而不是「点了有反应、文件是个空的」。 */
lastDownload = null
await tapAt('.myqr-btn--primary')
for (let i = 0; i < 40 && !lastDownload; i++) await sleep(200)
ok(
  lastDownload?.name === 'chatly-chenmo.png',
  '点「保存图片」发起了下载请求，文件名正确',
  lastDownload ? lastDownload.name : '没收到下载事件'
)
if (lastDownload?.url) {
  try {
    const b64 = await js(`fetch(${JSON.stringify(lastDownload.url)}).then(r=>r.arrayBuffer()).then(b=>{
      const u=new Uint8Array(b); let s=''
      for (let i=0;i<u.length;i+=0x8000) s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000))
      return btoa(s) })`)
    const buf = Buffer.from(b64, 'base64')
    const png = decodePng(buf)
    ok(
      decodeQrImageData(png) === expectedPayload,
      '下载的那个图片里解出来还是原文（不是空图 / 糊图）',
      `${png.width}×${png.height}, ${buf.length} 字节`
    )
  } catch (e) {
    ok(false, '下载的那个图片里解出来还是原文（不是空图 / 糊图）', String(e.message).slice(0, 80))
  }
}
console.log(`   · 说明：本机无头 Chrome 落盘失败（环境限制），文件系统层面的写入未在此校验`) 

/* ================= B. 扫一扫入口 + 摄像头 ================= */
console.log('\n─── B. 扫一扫入口与摄像头 ───')
await js(`document.querySelector('.sub-back').click()`)
await sleep(500)
await js(`window.__tab(0)`) // 聊天
await waitFor(`!!document.querySelector('.chat-head-act')`, 12000)

ok(await js(`!!document.querySelector('[data-testid="open-scan"]')`), '聊天页顶栏有「扫一扫」入口')
ok(
  await js(`(() => { const b=document.querySelector('[data-testid="open-scan"]'); return !!b && b.tagName==='BUTTON' && !b.disabled })()`),
  '入口是真的按钮'
)

await js(`document.querySelector('[data-testid="open-scan"]').click()`)
ok(await waitFor(`!!document.querySelector('.scan')`, 12000), '打开扫一扫页')
ok(await js(`!document.querySelector('.tabbar')`), '扫一扫是整屏覆盖层（底部 Tab 栏收起）')

const camLive = await waitFor(`window.__scan && window.__scan.cam === 'live'`, 20000)
ok(camLive, '摄像头起流成功（合成设备）', await js(`window.__scan?.camMsg || ''`))
ok(await js(`document.querySelector('.scan-video').videoWidth > 0`), 'video 真的有画面尺寸')
ok(await js(`document.querySelector('.scan-video').dataset.live === '1'`), 'UI 状态与真实起流一致')

await sleep(1200)
const frames = await js(`window.__scan.frames`)
ok(frames > 0, '解码循环真的在跑（不是只挂了个 video）', `已解码 ${frames} 帧`)
ok(
  (await js(`window.__scan.resultType`)) === null,
  '合成画面里没有二维码时不会误报结果'
)
await shoot(cdp, `${OUT}/02-scan-camera.png`)

/* ================= C. 相册识图 → 加好友 ================= */
console.log('\n─── C. 相册识图 → 加好友（真实落库） ───')
await injectFile('[data-testid="scan-file"]', IMG_TARGET)
ok(await waitFor(`!!document.querySelector('.scan-result')`, 15000), '相册选图后识别出结果')
ok((await js(`window.__scan.resultType`)) === 'user', '识别成「人」而不是别的类型')
const shownName = await js(`document.querySelector('.scan-person-txt b')?.textContent.trim()`)
ok(shownName === targetName, '资料卡显示的是码里那个人的昵称', `${shownName} / 期望 ${targetName}`)
ok(
  await js(`!!document.querySelector('[data-testid="scan-follow"]')`),
  '未关注时给出「加好友」按钮'
)
await shoot(cdp, `${OUT}/03-scan-result-user.png`)

await tapAt('[data-testid="scan-follow"]')
await waitFor(`!document.querySelector('[data-testid="scan-follow"]')`, 12000)
ok(dbFollows(me.user.id, targetId), `点「加好友」写进了 follows 表（${me.user.username} → ${TARGET}）`)
ok(
  (await js(`document.querySelector('.scan-chip')?.textContent.trim()`)) === '已加为好友',
  '按钮变成「已加为好友」，状态与库一致'
)
await shoot(cdp, `${OUT}/04-scan-followed.png`)

/* ================= D. 自己的码 ================= */
console.log('\n─── D. 扫到自己的码 ───')
await tapAt('[data-testid="scan-again"]')
await waitFor(`!document.querySelector('.scan-result')`, 12000)
await injectFile('[data-testid="scan-file"]', IMG_SELF)
ok(await waitFor(`!!document.querySelector('.scan-result')`, 15000), '识别自己的码')
ok(
  await js(`[...document.querySelectorAll('.scan-chip')].some(e=>e.textContent.includes('你自己'))`),
  '明确标出「这是你自己的码」'
)
ok(
  await js(`!document.querySelector('[data-testid="scan-follow"]')`),
  '自己的码上**没有**「加好友」（不能出现点了报错的按钮）'
)

/* ================= E. 群码 / 纯文本 ================= */
console.log('\n─── E. 群码与纯文本 ───')
await tapAt('[data-testid="scan-again"]')
await waitFor(`!document.querySelector('.scan-result')`, 12000)
await injectFile('[data-testid="scan-file"]', IMG_GROUP)
ok(await waitFor(`!!document.querySelector('[data-testid="scan-unsupported"]')`, 15000), '群码被识别出来')
const groupMsg = await js(`document.querySelector('[data-testid="scan-unsupported"]')?.textContent.trim()`)
ok(/后续版本/.test(groupMsg || ''), '群码明确写「后续版本支持」而不是假装能加入', String(groupMsg).slice(0, 40))
ok(
  await js(`![...document.querySelectorAll('.scan-btn')].some(b=>/加入|进群/.test(b.textContent))`),
  '群码上没有任何「加入群聊」按钮（不做假功能）'
)
await shoot(cdp, `${OUT}/05-scan-group.png`)

await tapAt('[data-testid="scan-again"]')
await waitFor(`!document.querySelector('.scan-result')`, 12000)
await injectFile('[data-testid="scan-file"]', IMG_TEXT)
ok(await waitFor(`!!document.querySelector('[data-testid="scan-code"]')`, 15000), '纯文本码识别成文本')
ok(
  (await js(`document.querySelector('[data-testid="scan-code"]')?.textContent.trim()`)) === '今天天气不错，出来走走',
  '文本内容原样展示'
)
ok(
  (await js(`document.querySelector('.scan-result')?.dataset.type`)) === 'text',
  '结果卡片标了 text 类型'
)

/* ================= F. 手动输入 ================= */
console.log('\n─── F. 手动输 ID ───')
await tapAt('[data-testid="scan-again"]')
await waitFor(`!document.querySelector('.scan-result')`, 12000)
await js(`[...document.querySelectorAll('.scan-act')].find(b=>b.textContent.includes('手动')).click()`)
ok(await waitFor(`!!document.querySelector('.scan-field input')`, 10000), '切到手动输入')

/* 用一个几乎不可能存在的 ID，测「查不到」的分支 */
await js(`window.__setInput('.scan-field input', 'nobody_zzz_999')`)
await sleep(200)
await js(`window.__btn('查找')`)
ok(await waitFor(`/没能查到/.test(document.querySelector('.scan-result')?.textContent||'')`, 12000), '不存在的 ID 明确报「没能查到」')

/* ⚠️ 结果面板一出现，输入框就被卸载了（同一块 `!result && (...)` 里）——
   必须先把结果收掉，否则下面 setInput 打在一个不存在的元素上，静默失败。 */
await tapAt('[data-testid="scan-again"]')
ok(await waitFor(`!!document.querySelector('.scan-field input')`, 12000), '「再扫一次」回到了手动输入（模式没被重置）')

await js(`window.__setInput('.scan-field input', '${TARGET}')`)
await sleep(200)
await js(`window.__btn('查找')`)
ok(await waitFor(`!!document.querySelector('.scan-person-txt b')`, 12000), '手输真实 ID 能查到人')
ok(
  (await js(`document.querySelector('.scan-person-txt b')?.textContent.trim()`)) === targetName,
  '查到的是同一个人'
)
ok(
  await js(`[...document.querySelectorAll('.scan-chip')].some(e=>e.textContent.includes('已加为好友'))`),
  '已加过的人显示「已加为好友」而不是又给一个「加好友」'
)
await shoot(cdp, `${OUT}/06-scan-manual.png`)

/* 结果卡上的「发消息」也要真的能进房间 —— 不然它就是个点了没反应的假按钮 */
await js(`window.__btn('发消息')`)
ok(await waitFor(`!!document.querySelector('.room')`, 15000), '点「发消息」真的进了聊天房间')
ok(
  (await js(`document.querySelector('.room-head .rh-name b')?.textContent.trim()`)) === targetName,
  '进的是和这个人的私聊',
  String(await js(`document.querySelector('.room-head .rh-name b')?.textContent.trim()`))
)
ok(await js(`!document.querySelector('.scan')`), '扫一扫覆盖层已让位（两个整屏层不会叠在一起）')

/* ================= 收尾：还原演示库 ================= */
console.log('\n─── 收尾 ───')
/* 必须**双向**还原：原来关注过就补回来，原来没关注就取关。
   只写 `if (targetHadEdge) POST` 的话，「原本没关注」这条路上
   测试期间新加的关注就留在库里了 —— 演示库会被自检搞脏。 */
if (targetHadEdge) await j('POST', `/users/${targetId}/follow`, null, me.auth)
else await j('DELETE', `/users/${targetId}/follow`, null, me.auth)
ok(dbFollows(me.user.id, targetId) === targetHadEdge, '关注关系还原到跑之前的状态', `原状 ${targetHadEdge}`)
fs.rmSync(IMG_TARGET, { force: true })
fs.rmSync(IMG_SELF, { force: true })
fs.rmSync(IMG_GROUP, { force: true })
fs.rmSync(IMG_TEXT, { force: true })

/* ================= 控制台 ================= */
console.log('\n─── 控制台 ───')
if (issues.length) {
  ok(false, '全程无 console 报错 / 未捕获异常', issues.slice(0, 4).join(' | '))
} else {
  ok(true, '全程无 console 报错 / 未捕获异常')
}

await ctx.close()

/* ================= G. 没有摄像头的环境 ================= */
console.log('\n─── G. 无摄像头环境（不带合成设备再起一次） ───')
{
  const p2 = await freePort()
  const dir2 = 'D:/BS-chat-os/.tmp/chrome-qr-nocam'
  fs.mkdirSync(dir2, { recursive: true })
  const proc2 = launchChrome({ url: APP, port: p2, profileDir: dir2 })
  const t2 = await waitAppTarget(p2, APP_HOST)
  const cdp2 = await connectCdp(t2.webSocketDebuggerUrl, () => {})
  const js2 = async (expr) => {
    const r = await cdp2.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js error')
    return r.result.value
  }
  const wait2 = async (expr, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      try {
        if (await js2(expr)) return true
      } catch {}
      await sleep(250)
    }
    return false
  }
  await cdp2.send('Runtime.enable')
  await cdp2.send('Page.enable')
  await cdp2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  await wait2(`!!document.querySelector('.lg-card, .login') || !!document.querySelector('.tabbar')`, 30000)
  if (await js2(`!!document.querySelector('.lg-card, .login')`)) {
    await ensureLoggedIn(js2)
    await wait2(`!!document.querySelector('.tabbar')`, 15000)
  }
  await sleep(600)
  await js2(`[...document.querySelectorAll('.tabbar .tab')][0].click()`)
  await wait2(`!!document.querySelector('[data-testid="open-scan"]')`, 12000)
  await js2(`document.querySelector('[data-testid="open-scan"]').click()`)
  await wait2(`!!document.querySelector('.scan')`, 12000)

  const errored = await wait2(`window.__scan && window.__scan.cam === 'error'`, 20000)
  ok(errored, '没有摄像头时进入明确的错误态（不是永远转圈）')
  const msg = await js2(`document.querySelector('[data-testid="cam-error"]')?.textContent.trim() || ''`)
  ok(msg.length >= 8 && !/^摄像头不可用$/.test(msg), '错误文案写的是具体原因', String(msg).slice(0, 50))
  ok(
    await js2(`!!document.querySelector('.scan-act') && ![...document.querySelectorAll('.scan-act')].find(b=>b.textContent.includes('相册')).disabled`),
    '摄像头不可用时，相册路径仍然可用'
  )
  await shoot(cdp2, `${OUT}/07-scan-nocam.png`)
  cdp2.close()
  proc2.kill()
}

console.log(`\n${'─'.repeat(52)}`)
console.log(failures ? `❌ ${failures} 项未通过` : '✅ 全部通过')
console.log(`截图：${OUT}`)
process.exit(failures ? 1 : 0)
