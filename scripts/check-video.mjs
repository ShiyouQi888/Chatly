/**
 * 视频动态专项自检：横屏 / 竖屏自适应 + 自建播放器 + 发布链路
 *
 * 核心是**几何断言**，不是「元素在不在」：
 *   - 横屏视频的容器比例必须 > 1，竖屏必须 < 1，两者差得明显（> 0.5）。
 *     如果两条都是 16:9，说明播放器没读真实宽高，而是写死了默认比例 ——
 *     「自适应横竖屏」根本没生效，而截图上两条都只是「一个深色方块」，看不出来。
 *   - 竖屏容器高度必须 ≤ 380：一条 9:16 的视频按真实比例能把卡片顶成两屏高。
 *   - 视频元素 `readyState >= 1 && videoWidth > 0`：真的解码出画面了，不是黑框。
 *   - 进度条 seek 到 70% 后 `currentTime / duration ≈ 0.7`：拖拽真的改了播放位置。
 *
 * 发布链路走真实文件（ffmpeg 造的 mp4），后端再核对 width / height / duration 落库 ——
 * 列表「在加载视频之前就按真实比例占位」全靠这三个数，编不出来。
 *
 * 跑法：node scripts/check-video.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import { freePort, waitAppTarget, connectCdp, launchChrome, shoot } from './lib/cdp.mjs'
import { purgeMoments, purgeOrphanUploads } from './lib/debris.mjs'
import { ensureLoggedIn } from './lib/session.mjs'

const API = 'http://127.0.0.1:3002/api/v1'
const APP_HOST = 'http://127.0.0.1:5198'
const APP = APP_HOST + '/'
const OUT = 'D:/BS-chat-os/shots/video'
const PASS = 'chatly123'
const SEED_DIR = 'D:/BS-chat-os/server/assets/seed'
const LAND_FILE = path.join(SEED_DIR, 'seed-video-landscape.mp4') // 640×360，6s
const PORT_FILE = path.join(SEED_DIR, 'seed-video-portrait.mp4') // 360×640，5s

const TAG = `自检·视频-${Date.now()}`

fs.mkdirSync(OUT, { recursive: true })

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

/** 走动态专用上传接口（kind 在 query 上：multer 的 limits 必须在解析前就知道） */
async function up(filePath, kind, auth, { mime, name } = {}) {
  const buf = fs.readFileSync(filePath)
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: mime || (kind === 'video' ? 'video/mp4' : 'image/png') }), name || path.basename(filePath))
  const r = await fetch(`${API}/moments/upload?kind=${kind}`, { method: 'POST', headers: auth, body: fd })
  const d = await r.json().catch(() => null)
  return { status: r.status, d }
}

const author = await login('chenmo')
await purgeMoments()
const baselineCount = (await j('GET', '/moments?scope=mine', null, author.auth)).d.moments.length
console.log(`自检开始（作者现有 ${baselineCount} 条自己的动态）\n`)

console.log('─── 后端：上传与校验 ───')
const upLand = await up(LAND_FILE, 'video', author.auth)
ok(upLand.status === 201 && upLand.d?.url?.startsWith('/uploads/'), '横屏视频上传成功', `${upLand.status} ${upLand.d?.url || upLand.d?.error || ''}`)

const upPort = await up(PORT_FILE, 'video', author.auth)
ok(upPort.status === 201, '竖屏视频上传成功', String(upPort.status))

const fakeMp4 = path.join('D:/BS-chat-os/.tmp', 'fake-selfcheck.mp4')
fs.mkdirSync(path.dirname(fakeMp4), { recursive: true })
fs.writeFileSync(fakeMp4, '这不是视频，只是一段文本\n'.repeat(20), 'utf8')
const fake = await up(fakeMp4, 'video', author.auth)
ok(fake.status === 400, '改名成 .mp4 的文本被挡下（文件头魔数校验）', `${fake.status} ${fake.d?.error || ''}`)

const created = await j(
  'POST',
  '/moments',
  {
    content: `${TAG} 后端直发`,
    visibility: 'public',
    media: [{ url: upLand.d.url, kind: 'video', fileName: 'land.mp4', fileSize: 53672, width: 640, height: 360, duration: 6 }],
  },
  author.auth
)
const cm = created.d?.moment
ok(created.status === 201 && cm?.kind === 'video', '发布视频动态成功，kind=video', `${created.status} kind=${cm?.kind}`)
ok(cm?.media?.[0]?.width === 640 && cm?.media?.[0]?.height === 360, '宽高按提交的值落库', `${cm?.media?.[0]?.width}×${cm?.media?.[0]?.height}`)
ok(Math.abs((cm?.media?.[0]?.duration || 0) - 6) < 0.5, '时长落库', String(cm?.media?.[0]?.duration))

const created2 = await j(
  'POST',
  '/moments',
  {
    content: `${TAG} 后端直发2`,
    visibility: 'public',
    media: [
      { url: upLand.d.url, kind: 'video', width: 640, height: 360, duration: 6 },
      { url: upPort.d.url, kind: 'video', width: 360, height: 640, duration: 5 },
    ],
  },
  author.auth
)
ok(created2.status === 400, '一条动态两个视频 → 400', `${created2.status} ${created2.d?.error || ''}`)

const mixed = await j(
  'POST',
  '/moments',
  {
    content: `${TAG} 混发`,
    visibility: 'public',
    media: [
      { url: upLand.d.url, kind: 'video', width: 640, height: 360, duration: 6 },
      { url: '/uploads/seed-chenmo-1.svg', kind: 'image' },
    ],
  },
  author.auth
)
ok(mixed.status === 400, '视频与图片混发 → 400（服务端也挡，不只是前端）', `${mixed.status} ${mixed.d?.error || ''}`)

const bad = await j(
  'POST',
  '/moments',
  { content: `${TAG} 外链`, visibility: 'public', media: [{ url: 'https://example.com/a.mp4', kind: 'video' }] },
  author.auth
)
ok(bad.status === 400, '外链地址 → 400（不允许把别人的 URL 写进动态）', String(bad.status))

const ghost = await j(
  'POST',
  '/moments',
  { content: `${TAG} 幽灵文件`, visibility: 'public', media: [{ url: '/uploads/not-exist.mp4', kind: 'video' }] },
  author.auth
)
ok(ghost.status === 400, '文件其实不在磁盘上 → 400', `${ghost.status} ${ghost.d?.error || ''}`)

const zero = await j(
  'POST',
  '/moments',
  {
    content: `${TAG} 零宽高`,
    visibility: 'public',
    media: [{ url: upLand.d.url, kind: 'video', width: 0, height: 0, duration: 0 }],
  },
  author.auth
)
ok(
  zero.status === 201 && zero.d?.moment?.media?.[0]?.width === null,
  '宽高给 0 → 存 NULL（不编数字，前端退默认比例）',
  JSON.stringify(zero.d?.moment?.media?.[0])
)

await await purgeMoments()

/* ================= 浏览器 ================= */
const port = await freePort()
const profileDir = `D:/BS-chat-os/.tmp/chrome-video`
fs.mkdirSync(profileDir, { recursive: true })
const proc = launchChrome({ url: APP, port, profileDir })
const target = await waitAppTarget(port, APP_HOST)
const issues = []
const cdp = await connectCdp(target.webSocketDebuggerUrl, (e) => {
  if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
    const text = (e.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    issues.push(`${e.params.type}: ${text}`.slice(0, 200))
  }
  if (e.method === 'Runtime.exceptionThrown') {
    issues.push('exception: ' + (e.params.exceptionDetails?.exception?.description || '').slice(0, 200))
  }
  if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
    issues.push(`${e.params.entry.level}: ${e.params.entry.text}`.slice(0, 200))
  }
})
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('DOM.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

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

/**
 * 真实鼠标事件（会生成带合法 pointerId 的 pointerdown）—— 比页内合成事件稳。
 *
 * ⚠️ 必须先 `scrollIntoView`：`Input.dispatchMouseEvent` 用的是**视口坐标**，
 * 而列表里的视频卡片在第 6、7 条，本来就在折叠线以下 —— 直接按 rect 派发，
 * 点下去落在别的卡片上（甚至落在屏幕外），看起来就像「点了没反应」。
 */
const tapAt = async (sel, fx = 0.5, fy = 0.5) => {
  const seen = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false
      e.scrollIntoView({ block: 'center' }); return true })()`
  )
  if (!seen) return false
  await sleep(350)
  const box = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null
      const r=e.getBoundingClientRect(); return { x: r.left + r.width*${fx}, y: r.top + r.height*${fy} } })()`
  )
  if (!box) return false
  /* 先把指针挪过去再按下 —— 真实用户也是这么操作的。
     消费端有一个真实用途：控制条 5 秒没用会自动收起，而它是靠 `pointermove` 叫回来的。
     只派发 press/release 的话，收起后的控制条点不到（`pointer-events: none`），
     会误报成「点了没反应」。 */
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 })
  return true
}

const HELP = `
window.__tab = (i) => { const t=[...document.querySelectorAll('.tabbar .tab')][i]; if(!t) return false; t.click(); return true }
window.__setValue = (sel, v) => {
  const el = document.querySelector(sel); if(!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
/* 播放器快照：比例是**渲染出来的盒子**量的，不是读 CSS 变量 —— 读变量等于自己验算自己 */
window.__vps = () => [...document.querySelectorAll('.moment-list .vp-root')].map(e => {
  const r = e.getBoundingClientRect()
  const v = e.querySelector('video')
  return {
    portrait: e.classList.contains('is-portrait'),
    landscape: e.classList.contains('is-landscape'),
    w: Math.round(r.width), h: Math.round(r.height),
    ar: +(r.width / r.height).toFixed(3),
    vw: v?.videoWidth || 0, vh: v?.videoHeight || 0,
    ready: v?.readyState || 0,
    dur: e.querySelector('.vp-dur')?.textContent.trim() || null,
    src: v?.getAttribute('src') || null,
    paused: v ? v.paused : null,
  }
})
window.__vpIn = (t) => {
  const c = [...document.querySelectorAll('.moment-list .mcard')].find(x => (x.querySelector('.mc-text')?.textContent||'').includes(t))
  return c ? c.querySelector('.vp-root') : null
}
window.__mv = () => {
  const v = document.querySelector('.media-viewer video')
  if (!v) return null
  return { paused: v.paused, t: +v.currentTime.toFixed(2), d: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : 0, ready: v.readyState }
}
/* 全屏查看器里的播放器盒子 —— 「像不像浏览器自带播放器」的量化判据。
   ⚠️ 光断言「元素在不在 / 有没有原生 controls」抓不到这个 bug：
      第一版控件全是自己写的、也没有 controls，但容器被撑满整个舞台、
      画面 contain 居中后上下各留一大片纯黑、控制条被推离画面几十像素，
      整体观感和浏览器自带播放器一模一样。只能量几何。 */
window.__mvBox = () => {
  const e = document.querySelector('.media-viewer .vp-root')
  const v = document.querySelector('.media-viewer video')
  if (!e || !v) return null
  const r = e.getBoundingClientRect()
  const vr = v.getBoundingClientRect()
  const bar = document.querySelector('.media-viewer .vp-bar')
  const br = bar ? bar.getBoundingClientRect() : null
  /* 和「容器有多大」比，「容器在哪儿」更容易被漏掉 —— 竖屏查看器第一版就是
     大小看着还行、整块却贴在左边缘。所以把左右余量也量出来。 */
  const vp = document.querySelector('.media-viewer .mv-vp')
  const pr = vp ? vp.getBoundingClientRect() : null
  const leftGap = pr ? Math.round(r.left - pr.left) : null
  const rightGap = pr ? Math.round(pr.right - r.right) : null
  return {
    cls: e.className,
    isFull: e.classList.contains('is-full'),
    w: Math.round(r.width), h: Math.round(r.height),
    ar: +(r.width / r.height).toFixed(3),
    vw: v.videoWidth, vh: v.videoHeight,
    mediaAr: v.videoWidth ? +(v.videoWidth / v.videoHeight).toFixed(3) : 0,
    leftGap, rightGap,
    offCenter: leftGap != null && rightGap != null ? Math.abs(leftGap - rightGap) : null,
    /* 控制条下沿距画面下沿多少像素 —— 贴画面是「定制胶囊」，几十像素 = 原生那条横贯底部的长条 */
    barGap: br ? Math.round(vr.bottom - br.bottom) : null,
    barH: br ? Math.round(br.height) : null,
    stageH: Math.round(window.innerHeight),
  }
}
window.__toast = () => document.querySelector('.toast')?.textContent.trim() || null
`

try {
  await js(HELP)
  const up = await waitFor(`!!document.querySelector('.lg-card, .login') || !!document.querySelector('.tabbar')`, 25000)
  if (!up) throw new Error('应用没挂载')
  await ensureLoggedIn(js)
  await sleep(600)
  await js(HELP)
  await js(`window.__tab(1)`)
  await waitFor(`!!document.querySelector('.moment-filters')`, 10000)
  await sleep(400)

  console.log('\n─── 列表：横屏 / 竖屏自适应 ───')
  ok(await waitFor(`document.querySelectorAll('.moment-list .vp-root').length >= 2`, 15000), '列表里出现 ≥2 个视频播放器')
  // 等视频元数据加载完，否则量到的是默认 16:9
  await waitFor(`window.__vps().every(v => v.ready >= 1 && v.vw > 0)`, 15000)
  await sleep(600)
  await js(HELP)

  let vps = await js(`window.__vps()`)
  const land = vps.find((v) => v.landscape)
  const port = vps.find((v) => v.portrait)
  ok(!!land, '有一条**横屏**视频（容器带 is-landscape）', JSON.stringify(land))
  ok(!!port, '有一条**竖屏**视频（容器带 is-portrait）', JSON.stringify(port))
  ok(!!land && land.ar > 1.3, '横屏容器是宽幅（宽/高 > 1.3）', String(land?.ar))
  ok(!!port && port.ar < 0.8, '竖屏容器是高幅（宽/高 < 0.8）', String(port?.ar))
  ok(
    !!land && !!port && Math.abs(land.ar - port.ar) > 0.5,
    '★ 横屏与竖屏的容器比例明显不同（不是都按 16:9 渲染）',
    `${land?.ar} vs ${port?.ar}`
  )
  ok(!!port && port.h <= 380, '竖屏容器高度封顶 ≤ 380（不把卡片顶成两屏）', String(port?.h))
  ok(!!land && !!port && land.w > port.w, '竖屏容器比横屏窄（按真实比例收了宽度，不留两侧黑边）', `${land?.w} vs ${port?.w}`)
  ok(
    vps.every((v) => v.ready >= 1 && v.vw > 0),
    '每个视频都真的解码出画面了（readyState ≥ 1 且 videoWidth > 0）',
    JSON.stringify(vps.map((v) => `${v.vw}x${v.vh}`))
  )
  ok(
    vps.some((v) => /^0:0[56]$/.test(v.dur || '')),
    '封面态显示时长角标（种子视频 0:06 / 0:05）',
    JSON.stringify(vps.map((v) => v.dur))
  )
  ok(
    vps.every((v) => (v.src || '').startsWith('/uploads/')),
    '视频地址走 /uploads/，不外链'
  )
  /* 两条视频在列表第 6、7 条，默认截图里在折叠线以下 —— 滚到它们再拍，
     否则存下来的「证据」只有几条图文动态。 */
  await js(`(() => {
    const s = document.querySelector('.moment-scroll')
    const e = document.querySelectorAll('.moment-list .vp-root')[0]
    if (!s || !e) return false
    s.scrollTop += e.getBoundingClientRect().top - 130
    return true
  })()`)
  await sleep(500)
  await shoot(cdp, `${OUT}/01-list.png`)

  console.log('\n─── 播放器：打开 / 播放 / 暂停 / 拖拽 ───')
  /* 点封面上的大播放按钮 → 进全屏查看器（朋友圈的主流行为，不是原地播） */
  await js(`(() => { const e=window.__vps(); return true })()`)
  const opened = await tapAt('.moment-list .vp-root .vp-big')
  ok(!!opened && (await waitFor(`!!document.querySelector('.media-viewer .mv-vp')`, 8000)), '点封面播放按钮打开查看器（不是原地播）')
  ok(await waitFor(`!!document.querySelector('.media-viewer .vp-bar')`, 8000), '查看器里出现自己的控制条（不是原生 controls）')
  ok(
    (await js(`!!document.querySelector('.media-viewer video[controls]')`)) === false,
    '★ 视频元素上没有原生 controls（原生控件会带出没接的画中画 / 下载按钮）'
  )
  ok(await waitFor(`window.__mv() && window.__mv().ready >= 2`, 12000), '查看器里视频加载完成')
  await sleep(1200)
  let mv = await js(`window.__mv()`)
  ok(mv && mv.paused === false, '进来就自动播放（autoPlay）', JSON.stringify(mv))
  await shoot(cdp, `${OUT}/02-viewer.png`)

  /* ★ 「定制 UI」的量化判据：容器必须**正好是画面的形状**，控制条必须**贴在画面下沿**。
     只断言「没有原生 controls / 有自己的 .vp-bar」是抓不到「看起来就是默认播放器」的。 */
  const box = await js(`window.__mvBox()`)
  ok(!!box, '查看器里能量到播放器盒子', JSON.stringify(box))
  ok(
    !!box && box.isFull === true,
    '★ 查看器里的播放器带 `is-full`（大屏布局类 —— 它曾经只由浏览器全屏驱动，查看器永远拿不到）',
    box?.cls
  )
  ok(
    !!box && box.offCenter != null && box.offCenter <= 2,
    '★ 播放器**水平居中**（不是贴着左边缘 —— 竖屏第一版就是被 `margin-right: auto` 顶到了左边）',
    `左余量 ${box?.leftGap} / 右余量 ${box?.rightGap}`
  )
  ok(
    !!box && Math.abs(box.ar - box.mediaAr) <= 0.02,
    '★ 播放器容器比例 = 视频真实比例（画面四周不留黑边 —— 查看器不套列表的比例夹取）',
    `容器 ${box?.ar} vs 画面 ${box?.mediaAr}`
  )
  ok(
    !!box && box.h < box.stageH * 0.8,
    '★ 容器没有撑满整个舞台（撑满 = 画面缩在中间、上下全是黑，最像原生播放器）',
    `容器高 ${box?.h} / 舞台 ${box?.stageH}`
  )
  ok(
    !!box && box.barGap != null && box.barGap <= 16,
    '★ 控制条贴着画面下沿（推到屏幕最下沿 = 原生播放器的标志形态）',
    `距画面下沿 ${box?.barGap}px`
  )
  ok(
    !!box && box.barH != null && box.barH <= 52,
    '控制条是贴边的玻璃胶囊，不是一条横贯屏幕的长条',
    `高 ${box?.barH}px`
  )

  await tapAt('.media-viewer .vp-ic[aria-label="暂停"]')
  await sleep(400)
  mv = await js(`window.__mv()`)
  ok(mv && mv.paused === true, '点暂停真的停了', JSON.stringify(mv))

  const beforeT = mv?.t ?? 0
  await tapAt('.media-viewer .vp-track', 0.7, 0.5)
  await sleep(400)
  mv = await js(`window.__mv()`)
  const ratio = mv && mv.d ? mv.t / mv.d : null
  ok(
    ratio != null && Math.abs(ratio - 0.7) < 0.18,
    '★ 拖进度条到 70% 真的跳过去了（不是只动了个滑块）',
    `${beforeT}s → ${mv?.t}s / ${mv?.d}s = ${ratio?.toFixed(2)}`
  )
  ok(mv && mv.paused === true, '拖拽不会顺手把视频播起来')
  await shoot(cdp, `${OUT}/03-seek.png`)

  await tapAt('.media-viewer .mv-btn[aria-label="关闭"]')
  ok(await waitFor(`!document.querySelector('.media-viewer')`, 8000), '关闭查看器')

  /* 竖屏那条也要走一遍查看器 —— 上面量的容器比例是横屏那条，
     竖屏的比例更容易被写死成 16:9（或者被 `width/height:100%` 撑满舞台）。 */
  console.log('\n─── 播放器：竖屏进查看器 ───')
  const openedPort = await js(`(() => {
    const e = document.querySelector('.moment-list .vp-root.is-portrait .vp-big')
    if (!e) return false
    const s = document.querySelector('.moment-scroll')
    if (s) s.scrollTop += e.getBoundingClientRect().top - 140
    e.click(); return true
  })()`)
  ok(!!openedPort, '能打开竖屏视频的查看器')
  ok(await waitFor(`!!document.querySelector('.media-viewer .vp-root')`, 8000), '竖屏查看器打开')
  ok(await waitFor(`window.__mv() && window.__mv().ready >= 2`, 12000), '竖屏视频加载完成')
  await sleep(300)
  const pbox = await js(`window.__mvBox()`)
  ok(!!pbox && pbox.isFull === true, '★ 竖屏查看器同样带 `is-full`', pbox?.cls)
  ok(
    !!pbox && pbox.offCenter != null && pbox.offCenter <= 2,
    '★ 竖屏播放器**水平居中**（这一条就是「左边空了一大块」的直接判据）',
    `左余量 ${pbox?.leftGap} / 右余量 ${pbox?.rightGap}`
  )
  ok(!!pbox && pbox.ar < 0.8, '★ 竖屏查看器容器是**高幅**（没被写成 16:9）', JSON.stringify(pbox))
  ok(
    !!pbox && Math.abs(pbox.ar - pbox.mediaAr) <= 0.02,
    '★ 竖屏容器比例 = 视频真实比例（0.6 的夹取只留给列表卡片，两侧不留黑条）',
    `容器 ${pbox?.ar} vs 画面 ${pbox?.mediaAr}`
  )
  ok(
    !!pbox && pbox.h < pbox.stageH * 0.8,
    '★ 竖屏容器同样没有撑满舞台',
    `容器高 ${pbox?.h} / 舞台 ${pbox?.stageH}`
  )
  ok(
    !!pbox && pbox.barGap != null && pbox.barGap <= 16,
    '竖屏控制条也贴着画面下沿',
    `距画面下沿 ${pbox?.barGap}px`
  )
  await shoot(cdp, `${OUT}/03c-viewer-portrait.png`)
  await tapAt('.media-viewer .mv-btn[aria-label="关闭"]')
  ok(await waitFor(`!document.querySelector('.media-viewer')`, 8000), '关闭竖屏查看器')

  console.log('\n─── 详情页 ───')
  await js(`(() => {
    const c = [...document.querySelectorAll('.moment-list .mcard')].find(x => x.querySelector('.vp-root'))
    if (!c) return false
    const b = [...c.querySelectorAll('.mc-act')].find(x => x.textContent.includes('查看详情'))
    if (!b) return false
    b.click(); return true
  })()`)
  ok(await waitFor(`!!document.querySelector('.md-root .vp-root')`, 10000), '详情页也按视频渲染（不是空的图片网格）')
  await waitFor(
    `(() => { const v=document.querySelector('.md-root video'); return !!v && v.videoWidth > 0 })()`,
    12000
  )
  const dv = await js(`(() => {
    const e = document.querySelector('.md-root .vp-root')
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { landscape: e.classList.contains('is-landscape'), ar: +(r.width / r.height).toFixed(3), vw: e.querySelector('video')?.videoWidth || 0 }
  })()`)
  ok(dv?.landscape === true && dv?.ar > 1.3, '详情页容器同样是宽幅（和列表同一套比例规则）', JSON.stringify(dv))
  ok(dv?.vw > 0, '详情页视频解码成功', `${dv?.vw}px 宽`)
  await shoot(cdp, `${OUT}/03b-detail.png`)
  await js(`document.querySelector('.md-back').click()`)
  ok(await waitFor(`!document.querySelector('.md-root')`, 8000), '从详情页返回列表')

  console.log('\n─── 发布视频动态 ───')
  await js(`document.querySelector('.moment-head .icon-btn--brand').click()`)
  ok(await waitFor(`!!document.querySelector('.mc-root')`), '打开发布面板')
  ok(
    (await js(`!!document.querySelector('.mc-vpick') && !document.querySelector('.mc-vpick').disabled`)),
    '「选一个视频」按钮可用（视频不再是未接入的假按钮）'
  )
  ok(
    (await js(`[...document.querySelectorAll('.mc-pending-item')].map(b=>b.textContent.trim())`)).every((t) => !/视频/.test(t)),
    '未接入清单里已经没有「视频动态」了',
    JSON.stringify(await js(`[...document.querySelectorAll('.mc-pending-item')].map(b=>b.textContent.trim())`))
  )

  /* 往隐藏的 video input 注入真实 mp4（DOM.setFileInputFiles 对 hidden input 也有效） */
  const doc = await cdp.send('DOM.getDocument', { depth: -1 })
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[accept^="video"]' })
  ok(!!node.nodeId, '找到视频选择框')
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [LAND_FILE] })
  ok(await waitFor(`!!document.querySelector('.mc-video .vp-root')`, 20000), '上传后发布面板里出现播放器预览')
  await waitFor(`(() => { const v=document.querySelector('.mc-video video'); return !!v && v.readyState >= 1 })()`, 15000)
  const metaText = await js(`document.querySelector('.mc-video-meta')?.textContent.trim()`)
  ok(/0:0\d/.test(metaText || ''), '预览下方显示时长', metaText)
  ok(/(KB|MB)/.test(metaText || ''), '预览下方显示体积', metaText)
  ok(/\d+×\d+/.test(metaText || ''), '预览下方显示分辨率（宽高读出来了）', metaText)
  await shoot(cdp, `${OUT}/04-composer.png`)

  await js(`window.__setValue('.mc-textarea', ${JSON.stringify(TAG)})`)
  await js(`document.querySelector('.mc-send').click()`)
  ok(await waitFor(`!document.querySelector('.mc-root')`, 12000), '发布后面板关闭')
  await sleep(1000)

  const mine = (await j('GET', '/moments?scope=mine', null, author.auth)).d.moments
  const pub = mine.find((m) => (m.content || '').includes(TAG))
  ok(!!pub && pub.kind === 'video', '后端核对：落库了且 kind=video', pub ? `#${pub.id} kind=${pub.kind}` : '没找到')
  ok(pub?.media?.[0]?.kind === 'video', '媒体 kind 是 video', pub?.media?.[0]?.kind)
  ok(pub?.media?.[0]?.width === 640 && pub?.media?.[0]?.height === 360, '宽高真的读出来并落库', `${pub?.media?.[0]?.width}×${pub?.media?.[0]?.height}`)
  ok(Math.abs((pub?.media?.[0]?.duration || 0) - 6) < 0.6, '时长真的读出来并落库', String(pub?.media?.[0]?.duration))

  ok(
    await waitFor(`!!window.__vpIn(${JSON.stringify(TAG)})`, 12000),
    '列表里立刻出现刚发的视频动态（不用刷新）'
  )
  await waitFor(`(() => { const e=window.__vpIn(${JSON.stringify(TAG)}); const v=e && e.querySelector('video'); return !!v && v.readyState>=1 && v.videoWidth>0 })()`, 15000)
  const newVp = await js(
    `(() => { const e=window.__vpIn(${JSON.stringify(TAG)}); if(!e) return null
      const r=e.getBoundingClientRect(); const v=e.querySelector('video')
      return { landscape: e.classList.contains('is-landscape'), ar:+(r.width/r.height).toFixed(3), w:Math.round(r.width), vw:v?.videoWidth||0 } })()`
  )
  ok(newVp?.landscape && newVp?.ar > 1.3, '新发的横屏视频在列表里也是宽幅', JSON.stringify(newVp))
  ok(newVp?.vw === 640, '播放的是上传的那一支（videoWidth=640）', String(newVp?.vw))
  await shoot(cdp, `${OUT}/05-published.png`)

  console.log('\n─── 「我的动态」子页 ───')
  await js(`window.__tab(3)`)
  await waitFor(`!!document.querySelector('.me-stats')`, 10000)
  await sleep(1000)
  await js(HELP)
  await js(`document.querySelectorAll('.me-stats button')[1].click()`)
  ok(await waitFor(`!!document.querySelector('.subpage .mini-post')`, 10000), '打开「我的动态」子页')
  await sleep(600)
  ok(
    await waitFor(`!!document.querySelector('.subpage .mp-cell.is-video video')`, 10000),
    '★ 子页里视频显示成视频缩略图（<video> + 播放角标），不是当成 <img> 渲染成黑框'
  )
  await shoot(cdp, `${OUT}/06-myposts.png`)
} catch (e) {
  console.error('\n💥 自检中断：', e.message)
  failures++
} finally {
  proc.kill()
  const p = await purgeMoments()
  await purgeOrphanUploads({ quiet: true })
  if (p.moments) console.log(`\n已清理临时动态 ${p.moments} 条（媒体 ${p.media} / 赞 ${p.likes} / 评论 ${p.comments}）`)

  const noise = /favicon|DevTools|ExperimentalWarning|Autoplay is only allowed/i
  const real = [...new Set(issues.filter((x) => !noise.test(x)))]
  if (real.length) {
    console.log(`\n❌ 控制台有 ${real.length} 条问题：`)
    real.forEach((x) => console.log('  •', x))
    failures += real.length
  }
}

console.log(`\n${failures === 0 ? '✅ 视频动态自检全部通过' : `❌ ${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
